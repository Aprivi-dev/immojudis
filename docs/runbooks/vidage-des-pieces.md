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

   Deux fins ne sont ni une lecture ni un échec (tâche `queued`, aucun essai consommé) :
   - `PDF pass deferred: the persisted manifest is complete and no document is due for revalidation` : le
     manifeste enregistré est complet, ses vérifications ont moins de 24 heures, et son texte n'est pas
     restaurable sur ce runner (manifeste avec un lien mort ou une pièce bloquée). Il n'y a rien à lire.
     `next_attempt_at` est l'heure où la première vérification expire : la vente est alors relue.
   - `PDF pass deferred: the final catalogue write was discarded (...)` : l'écriture de fin de passe n'a
     rien écrit. Entre parenthèses, `the sale changed during the pass` (nouvel essai 30 minutes plus tard),
     ou le motif d'admission, `expired` ou `missing_price_and_surface` (nouvel essai un jour plus tard).

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
   select substring(last_error from 'retry required: ([a-z_ ]+)') as raison, count(*)
   from public.auction_enrichment_jobs
   where job_type = 'pdf' and status = 'failed'
     and last_error like 'PDF document checkpoint was not persisted%'
   group by 1
   order by 2 desc;
   ```

   `no_progress_entries` : la passe n'avait aucun texte à enregistrer. Sur un manifeste déjà complet, c'est
   un texte perdu (lignes d'extraction absentes) : la vente est relue quand ses vérifications expirent.

5. **Le verrou.** `stop_reason = catalogue_lock`, ou de longues attentes entre deux ventes : une collecte
   tient le verrou du catalogue (jusqu'à 35 minutes, 50 pour Licitor). Ce n'est pas un défaut du vidage.

6. **La lecture des pièces est-elle effacée ailleurs ?** Si le nombre de ventes à relire remonte sans
   que le vidage ait échoué, une collecte efface peut-être `document_facts_version` (incidents corrigés
   par #422 et #425).

## Plafond de relecture et tâches en attente

Règles posées le 11/11/2026 (lot R6, note
[file de lecture des pièces](../audits/2026-11-11-file-de-lecture-des-pieces.md)).

- **Plafond de relecture.** Le vidage ne choisit pas une vente qui compte déjà 2 lectures pdf terminées
  dans les 24 dernières heures, quelle que soit l'empreinte des tâches
  (`MAX_COMPLETED_READS_PER_DAY`, `src/document_backlog.py`). Seules les lectures terminées comptent : une
  tâche annulée, en échec ou reportée n'a rien lu. Conséquence voulue : une vente réellement modifiée une
  troisième fois dans la journée n'est plus prise par le vidage ce jour-là ; sa tâche reste en file et la
  voie générale la sert à son rang. Les ventes au plafond :

  ```sql
  select source_url, count(*) as lectures_terminees_24h
  from public.auction_enrichment_jobs
  where job_type = 'pdf' and status = 'completed' and completed_at >= now() - interval '24 hours'
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
- **Tâche qui attend.** Les deux fins `PDF pass deferred` (point 2 du diagnostic) laissent la tâche en
  file avec une échéance. Le vidage ne la reprend pas avant cette échéance et n'enchaîne pas la même passe.
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
  est une tâche `queued` ordinaire, reprise à son échéance par l'ancien code comme par le nouveau.
