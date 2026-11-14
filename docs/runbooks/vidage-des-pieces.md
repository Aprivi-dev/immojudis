# Vidage des pièces jointes : rendement faible, passes partielles répétées

Le vidage (`services/data-pipeline/src/document_backlog.py`) lit les pièces jointes (PDF) des ventes
actionnables. Il tourne de deux façons :

- **après chaque passage de la file d'enrichissement**, lancé par `src/autonomous_runner.py` : 6 ventes
  au plus, 8 minutes ;
- **à la main**, avec l'entrée `documents_backlog` du workflow _Immojudis Data Pipeline_ : 200 ventes et
  120 minutes par défaut (`limit`, `documents_budget_minutes`, 150 minutes au plus).

Chaque vente prend le verrou d'écriture du catalogue pour ses passes. La **lecture en avance**
(`src/document_prefetch.py`) télécharge et lit les pages des ventes suivantes dans des processus à part,
hors du verrou et sans écriture en base. Historique et cause de la boucle du 04/11/2026 :
[post-mortem](../audits/2026-11-04-post-mortem-vidage-pieces.md).

Les requêtes ci-dessous sont en lecture seule. Toute écriture en base (fermer une alerte, remettre des
tâches en file) est une action du propriétaire.

## Symptômes

- **Alerte `pipeline.documents_backlog.low_yield`** (avertissement, catégorie `import`) : un vidage de plus
  de 30 minutes (attente du verrou du catalogue retranchée) a lu moins de 4 ventes par heure, ou plus de
  30 % de ses passes sont partielles. Voir « L'alerte » plus bas.
- **Passes partielles répétées.** Dans le journal, une vente enchaîne `passes=4` avec le même
  `extracted a->a/n`, et ses tâches pdf finissent en `PDF document manifest is partial; continue the next
bounded pass`. Une passe partielle est normale pour une vente de plus de six pièces
  (`PDF_MAX_DOCUMENTS_PER_SALE`) ou un long rapport scanné. Une passe qui ne lit **aucune** pièce de plus
  ne l'est pas.
- **Points d'étape refusés** : `PDF document checkpoint was not persisted; retry required: <raison>`. La
  raison est journalisée depuis #423 et, depuis le 11/11/2026, écrite dans `last_error` de la tâche (un
  code comme `no_progress_entries`, jamais l'URL de la pièce). Une vente en échec attend un jour avant
  d'être reprise.
- **Une vente relue à chaque passage de la file.** Symptôme du 11/11/2026 : 3 ventes prenaient 104 des 200
  lectures pdf terminées en 48 heures. Voir « Plafond de relecture et tâches en attente » plus bas.
- **Rendement en baisse** dans le résumé d'étape du workflow (« Pièces jointes : vidage du stock »).
  Référence du 05/11/2026 sans lecture en avance : 43 ventes traitées sur 80 candidates en 150 minutes.
- La sentinelle `catalogue.quality.documents_incomplete` s'ouvre : plus de 30 ventes en ligne ont une
  pièce « incomplete » depuis plus de 3 jours.

## Diagnostic

1. **Le bilan du vidage.** Le résumé d'étape du workflow, et la ligne JSON imprimée en fin de journal,
   donnent :
   - `sales_read` : ventes traitées dont toutes les pièces sont lues avec les règles actuelles à la fin ;
   - `passes`, `partial_passes`, `partial_pass_share` : passes conclues sur un manifeste partiel (tâche
     remise en file avec « manifest is partial », ou remplacée après un point d'étape durable) ;
   - `refused_checkpoints` : passes conclues sur « checkpoint was not persisted » ;
   - `waiting_passes` : passes conclues sur « rien à lire » (la tâche attend la revalidation d'un manifeste
     complet, voir le point 2) ;
   - `elapsed_seconds`, `stop_reason` (`candidates_exhausted`, `budget`, `catalogue_lock`,
     `catalogue_lock_lost`) ;
   - `lock_wait_seconds` : temps passé à attendre le verrou du catalogue, retranché de la durée évaluée par
     l'alerte ;
   - `prefetch` : `workers`, `prepared`, `documents`, `read`, `cached`, `deferred_exhausted` (pièces encore
     reportées après tous les tours d'OCR de la préparation) et `errors` ;
   - `low_yield` : décision de l'alerte et résultat de l'enregistrement (`sync`).

   La ligne `Document backlog yield: ...` du journal reprend ces chiffres.

2. **Les fins de passe des dernières 24 heures.**

   ```sql
   select status, left(coalesce(last_error, ''), 60) as fin, count(*)
   from public.auction_enrichment_jobs
   where job_type = 'pdf' and updated_at >= now() - interval '24 hours'
   group by 1, 2
   order by 3 desc;
   ```

   Trois fins datent du 11/11/2026 :
   - `PDF pass deferred: the persisted manifest is complete and no document is due for revalidation`
     (tâche `queued`, aucun essai consommé) : le manifeste enregistré est complet, il contient une URL
     écartée (lien mort, pièce bloquée, lien non documentaire), donc son texte n'est pas restaurable sur ce
     runner, et ses vérifications ont moins de 24 heures. Il n'y a rien à lire. `next_attempt_at` est l'heure
     où la première vérification expire : la vente est alors relue. Un manifeste complet sans URL écartée
     dont le texte manque n'attend pas : il échoue (point 4).
   - `PDF pass not recorded: the final catalogue write was discarded (<code>)` (tâche `failed`, un essai
     consommé) : l'écriture de fin de passe n'a rien écrit. `revision_moved` : la ligne de la vente a changé
     pendant la passe, nouvel essai 30 minutes plus tard, quatre essais au plus. `expired` ou
     `missing_price_and_surface` : refus d'admission, nouvel essai un jour plus tard.
   - `review_required: final catalogue write refused (<code>, <version des faits>)` (tâche `cancelled`) :
     quatrième refus d'admission de suite. Le vidage ne réveille pas cette tâche pendant 7 jours
     (`REVIEW_HOLD_DAYS`) si l'audience est à plus de 7 jours, pendant 1 jour sinon (audience proche ou vente
     sans date). L'attente tombe avant si les règles de lecture changent (la version du message n'est plus
     `DOCUMENT_FACTS_VERSION`) ou si une génération plus récente, non annulée, existe (pièces changées). Une
     génération plus récente annulée ne la lève pas : la liste des pièces est revenue à celle de la tâche en
     revue. À regarder : la vente n'a plus ni prix ni surface une fois ses pièces relues, ou elle est expirée.

3. **Une vente qui boucle.** Le manifeste dit ce qui reste à lire :

   ```sql
   select source_url,
          raw_payload->'document_analysis'->'http_revalidation_pending_urls' as revalidation_en_attente,
          raw_payload->'document_analysis'->'failed_documents' as pieces_en_echec,
          raw_payload->>'document_facts_version' as version_des_faits
   from public.auction_sales
   where source_url = '<url de la vente>';
   ```

   Des URL qui restent dans `http_revalidation_pending_urls` d'un vidage à l'autre rappellent la cause du
   04/11 (corrigée par #421). Si cela revient, couper la lecture en avance (section suivante) et comparer
   avec le vidage suivant.

4. **Points d'étape refusés.** La raison suit le message, dans le journal du workflow (chercher
   `checkpoint`) et dans `last_error` (analyse absente, schéma ou empreinte, cache local absent, pages ou
   textes qui ne concordent pas, révision déplacée avant l'écriture) :

   ```sql
   select substring(last_error from 'retry required: ([a-z_]+)') as raison, count(*)
   from public.auction_enrichment_jobs
   where job_type = 'pdf' and status = 'failed'
     and last_error like 'PDF document checkpoint was not persisted%'
   group by 1
   order by 2 desc;
   ```

   Les raisons sont des codes. `no_progress_entries` : la passe n'avait aucun texte à enregistrer ; sur un
   manifeste déjà complet et sans URL écartée, c'est un texte perdu (lignes d'extraction absentes, preuve
   altérée), relu quand ses vérifications expirent. `obsolete_revision` et `revision_moved` : la ligne de la
   vente a changé avant ou pendant l'écriture du point d'étape. `no_direct_connection` : pas de connexion
   PostgreSQL directe.

5. **Le verrou.** `stop_reason = catalogue_lock`, ou de longues attentes entre deux ventes : une collecte
   tient le verrou du catalogue (jusqu'à 35 minutes, 50 pour Licitor). Ce n'est pas un défaut du vidage.

6. **La lecture des pièces est-elle effacée ailleurs ?** Si le nombre de ventes à relire remonte sans
   que le vidage ait échoué, une collecte efface peut-être `document_facts_version` (incidents corrigés
   par #422 et #425).

## Plafond de relecture et tâches en attente

Règles posées le 11/11/2026 (lot R6, note
[file de lecture des pièces](../audits/2026-11-11-file-de-lecture-des-pieces.md)).

- **Plafond de relecture.** Le vidage ne choisit pas une vente pour laquelle il a déjà demandé 2 lectures
  pdf terminées dans les 24 dernières heures, quelle que soit l'empreinte des tâches
  (`MAX_COMPLETED_READS_PER_DAY`, `src/document_backlog.py`). Ne comptent que les tâches terminées à la
  priorité du vidage (40) : une tâche annulée, en échec ou reportée n'a rien lu, et une tâche de la voie
  générale (priorité 30) se termine souvent sans passe, pièces à jour après restauration. Conséquence
  voulue : une vente réellement modifiée une troisième fois dans la journée n'est plus prise par le vidage
  ce jour-là ; sa tâche reste en file et la voie générale la sert à son rang. Les ventes au plafond :

  ```sql
  select source_url, count(*) as lectures_terminees_24h
  from public.auction_enrichment_jobs
  where job_type = 'pdf' and status = 'completed' and priority >= 40
    and completed_at >= now() - interval '24 hours'
  group by 1
  having count(*) >= 2
  order by 2 desc
  limit 50;
  ```

  Une vente qui y revient chaque jour reste « à relire » après chaque lecture : regarder son manifeste
  (point 3 du diagnostic) plutôt que relever le plafond.

- **Vente sans texte.** Une vente dont toutes les pièces sont écartées (liens morts, robots) ou vides a
  un manifeste complet : sa version des faits (`document_facts_version`) est posée, elle n'est plus à
  relire à chaque vidage.
- **Tâche qui attend.** La fin `PDF pass deferred` (point 2 du diagnostic) laisse la tâche en file avec
  une échéance. Le vidage ne la reprend pas avant cette échéance et n'enchaîne pas la même passe ; la visite
  compte dans `waiting_passes`. Tant qu'elle attend, les passes de faits de la vente attendent aussi (garde
  de la prise, migration `20261111050000`).
- **Écriture de fin de passe écartée.** La tâche pdf échoue avec son code, un essai consommé : elle ne peut
  plus tourner sans fin. Remettre plus tôt en file une tâche `review_required` est une écriture en base :
  décision du propriétaire.
- **Valeur remise quand une valeur de pièce est effacée.** Chaque relecture complète efface d'abord les
  valeurs lues dans les pièces et remet celles de la source, depuis `source_factual_snapshot`. Règle :
  ne jamais faire apparaître une valeur que la collecte n'aurait pas écrite pour la vente
  (`_pdf_source_reader`, `src/pdf_fact_scope.py`). L'instantané est relu par `normalize_sale` avec le
  contexte de la collecte repris du `raw_payload` de la vente (lot de l'annonce, drapeaux, titre, blocs de
  la fiche, précision des dates). Sur une annonce Licitor à plusieurs lots dont le lot n'est plus désigné
  (`source_lot_selection` absent), seul ce que l'instantané porte pour le champ est remis, sans relire le
  texte de la page ; un champ vide reste vide. Si l'instantané ne se lit pas, le champ est remis vide et le
  journal porte `Source snapshot unreadable for <url> : field <champ>`, sans la valeur. Limites : dans le
  cas sans lot, un type de bien peut être remis `other` au lieu du type lu par la collecte, et un
  instantané pris avant la lecture lot par lot (03/11/2026) porte les valeurs du premier lot.
- **Lecture en avance.** Une pièce est à revalider quand sa vérification enregistrée en base a plus de
  24 heures. Le fichier de suivi local (`.http.json`), que la lecture en avance rafraîchit, ne sert plus
  qu'à éviter une requête : il ne décide plus si la pièce est reprise.

## Interrupteur : nombre de processus de lecture en avance

Variable de dépôt GitHub `DOCUMENT_BACKLOG_PREFETCH_WORKERS` (Settings, Secrets and variables, Actions,
onglet Variables). Le workflow la lit à chaque exécution (`.github/workflows/data-pipeline.yml`), pour le
vidage manuel comme pour celui qui suit chaque passage de la file. Aucun commit n'est nécessaire.

| Valeur                       | Effet                                                                 |
| ---------------------------- | --------------------------------------------------------------------- |
| absente                      | 3 processus (défaut du workflow)                                      |
| `0`                          | lecture en avance coupée : une vente à la fois, sous le verrou        |
| `1` à `6`                    | ce nombre de processus                                                |
| plus de `6`                  | 6 (plafond de `src/document_prefetch.py`)                             |
| négative                     | 0                                                                     |
| non numérique (`off`, `non`) | **3** : la valeur est ignorée. Pour couper, écrire `0`, rien d'autre. |

`0` reste possible avec l'expression `${{ vars.DOCUMENT_BACKLOG_PREFETCH_WORKERS || '3' }}` : une
variable de dépôt est une chaîne, et `'0'` est une chaîne non vide, donc retenue telle quelle. Seules une
variable absente ou vide prennent le défaut. Le test
`test_the_workflow_takes_the_worker_count_from_a_repository_variable` vérifie l'expression.

Couper (exemple avec la CLI GitHub, droits d'administration du dépôt) :

```bash
gh variable set DOCUMENT_BACKLOG_PREFETCH_WORKERS --body 0
```

Chaque processus multiplie le délai par hôte (`PDF_HOST_MIN_DELAY_SECONDS`) par le nombre de processus.
Le rythme cumulé vers un même site ne dépend donc pas de ce réglage.

## Point connu : OCR orphelin après l'arrêt d'un processus de lecture en avance

Suivi ouvert le 14/11/2026 (état des lieux, D20), non corrigé. Une fois l'échéance du vidage passée,
`DocumentPrefetcher.close()` arrête les processus de lecture en avance encore vivants après
`STOP_GRACE_SECONDS` (10 s). Un `tesseract` lancé par l'un d'eux (`src/pdf_ocr.py`, `subprocess.run`) n'est
pas arrêté avec lui : le délai de `subprocess.run` est tenu par le processus arrêté. L'orphelin vit le temps
de l'OCR de sa page, et le runner GitHub tue les processus restants en fin de job.

Correction prévue : lancer `tesseract` avec `start_new_session=True` et arrêter son groupe de processus quand
le processus de lecture reçoit SIGTERM, ou lui faire recevoir la mort de son parent (`PR_SET_PDEATHSIG`, Linux).
Une demi-douzaine de tests simulent `subprocess.run` et seraient à reprendre.

## Retour à la normale

1. Supprimer la variable (`gh variable delete DOCUMENT_BACKLOG_PREFETCH_WORKERS`) ou la remettre à `3`.
2. Lancer un vidage manuel (`documents_backlog`, budget de 120 à 150 minutes) une fois la cause corrigée.
3. Une vente bloquée un jour par un échec est reprise d'elle-même le lendemain. La remettre en file plus
   tôt est une écriture en base : décision du propriétaire.

## Vérification

Sur le vidage manuel suivant (résumé d'étape) :

- `refused_checkpoints` à 0, ou des raisons comprises et suivies ;
- `partial_pass_share` sous 30 %, sans vente qui enchaîne des passes sans lire de pièce ;
- `sales_read` comparable à la référence : 43 ventes traitées en 150 minutes sans lecture en avance le
  05/11/2026. Avec 3 processus, le rendement attendu est supérieur, mais il reste à mesurer ;
- `prefetch.errors` faible, `prefetch.deferred_exhausted` limité aux longs rapports scannés ;
- l'alerte `pipeline.documents_backlog.low_yield` n'est pas rouverte.

## L'alerte `pipeline.documents_backlog.low_yield`

- **Règle** (`src/document_backlog_yield.py`, constantes `LOW_YIELD_*`) : seul un vidage de **plus de
  30 minutes**, attente du verrou du catalogue retranchée (`lock_wait_seconds`), est évalué. L'alerte est
  active si son débit est de **moins de 4 ventes lues par heure** (`sales_read_per_hour`, sur la durée
  évaluée), ou si **plus de 30 %** de ses passes sont partielles. Le seuil de débit vaut environ le quart
  de la référence saine du 05/11/2026 (43 ventes en 150 minutes, environ 17 par heure) : il signale un
  vidage qui tourne sans lire, pas un vidage simplement plus lent. Un vidage plus court, dont celui de
  8 minutes après chaque passage de la file, ne touche pas l'alerte, pas plus qu'un vidage arrêté faute
  d'avoir obtenu le verrou (`stop_reason` = `catalogue_lock`). Ces seuils (revue de code du 08/11/2026)
  restent à recalibrer sur les premiers vidages mesurés.
- **Enregistrement** : en fin de vidage, `app_private.sync_documents_backlog_low_yield_alert` (migration
  `20261111131500`), qui passe par le mécanisme commun `app_private.sync_operational_alert`. Tant que la
  migration n'est pas appliquée, le journal dit `is not deployed yet` et le vidage se termine normalement.
- **Détail** : `select details from public.operational_alerts where alert_key =
'pipeline.documents_backlog.low_yield';` (bilan chiffré, durée évaluée et débit,
  `reasons` : `low_read_rate`, `partial_passes`, et seuils).
- **Fermeture** : un vidage long sain marque la condition levée. L'alerte se ferme au premier vidage long
  évalué au moins deux heures plus tard (hystérésis commune). Les vidages longs étant manuels, la
  fermeture peut se faire attendre. La fermer à la main est une écriture en base, décidée par le
  propriétaire.

## Retour arrière

- **Lecture en avance** : variable à `0` (voir « Interrupteur »). C'est le retour arrière immédiat, sans
  déploiement.
- **Pilotage par variable** : revenir au commit précédent du workflow remet la valeur écrite en dur.
- **Alerte** : `drop function app_private.sync_documents_backlog_low_yield_alert(boolean, jsonb,
timestamptz);` (migration du propriétaire). Le vidage note alors `is not deployed yet` et continue. Le bilan
  du résumé d'étape reste.
- **Correctifs de la série #413 à #430** : un `git revert` du commit concerné, après lecture de son
  message. #421 et #422 corrigent des pertes de lecture : ne pas les annuler sans remplacement.
- **Lot R6 du 11/11/2026** (plafond de relecture, tâches en attente, motif dans `last_error`) : un
  `git revert` du commit concerné. Aucune migration, aucune donnée à reprendre : une tâche en attente
  est une tâche `queued` ordinaire, reprise à son échéance par l'ancien code comme par le nouveau, et une
  tâche annulée `review_required` est réveillée par l'ancien vidage dès sa visite suivante.
