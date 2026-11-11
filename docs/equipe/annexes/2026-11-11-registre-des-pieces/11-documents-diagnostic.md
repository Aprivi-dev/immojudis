<!-- Rapport du spécialiste `data-pipeline`, rendu le 11/11/2026 dans la mission « registre des pièces » : premier diagnostic de la file de lecture des documents (lot R6), par lecture du code. Une partie de ses hypothèses a été infirmée par les mesures de l'annexe 12 ; l'annexe 13 le révise. Reproduit tel quel : c'est une analyse, pas une décision. Les décisions sont dans `docs/equipe/2026-11-11-registre-des-pieces.md`. -->

# R6, file des documents : diagnostic en lecture seule

Légende : **[L]** lu dans le code, **[E]** exécuté hors dépôt (aucune base, aucun réseau), **[S]** supposé, à mesurer.
Vérifications [E] : `ruff check .` sans erreur ; `pytest` complet 6 374 réussis, 162 ignorés, 15 désélectionnés (197 s, Python 3.12). Dépôt inchangé (`git status` vide), aucun workflow lancé, aucune écriture.
Chemins courts ci-dessous : liste absolue en fin de rapport.

## 1. Pourquoi la file ne se vide pas

- **Ordre [L]** : score SQL = priorité + âge en heures + 24 pour une tâche pdf + 168 si la vente a lieu sous 7 jours (migrations 20261111050000 à 070000). Une seule tâche générale par prise (`queued_runner.py:1480, 1502`), cycle de 3 `source_detail` pour 1 générale, 1 pour 1 si l'estimation des tâches générales dues est la plus grande (l.92, 98, 1450-1470).
- **Budget [L]** : 1 200 s par run dont 60 s de marge (l.94, 1146), puis vidage de 6 ventes en 8 min seulement si le travailleur sort en 0 (`autonomous_runner.py:552, 726`), lecture IA, positions, photos, historique Licitor : d'où 26 à 29 min. Même groupe de concurrence GitHub que les collectes (`data-pipeline.yml:70`) : environ 27 ticks par jour, pas 48 (`document_backlog.py:146`).
- **Recul [L]** : échec = +30 min, 4 essais (`supabase_client.py:1450`, défaut de la table), puis lettre morte que seul le vidage réarme, un jour après (`document_backlog.py:154-180, 199-202`). Reports sans essai consommé : 30 min (manifeste partiel), 24 h (vente dont toutes les sources sont retirées, accès Enchères Publiques non autorisé : `source_withdrawal.py:53-57`).
- **Une tâche ancienne et due a le meilleur score** : si 112 tâches des 05 et 06/11 ne sont pas touchées, elles ne sont pas dues ou pas prenables, ce n'est pas d'abord un manque de capacité [déduction, mesure M2]. Causes lues : (a) reports de 24 h en boucle sans fin pour les ventes Vench, Petites Affiches, Enchères Publiques ; (b) échecs déterministes (points 2 et 3) qui brûlent 4 essais en 2 h puis attendent le vidage du lendemain ; (c) `queued_runner.py:945-950` puis `1162-1168` : dès qu'une passe de faits rencontre un budget IA épuisé, toute la voie générale est fermée jusqu'à la fin du run, tâches pdf comprises alors qu'elles n'appellent aucun modèle [S pour la fréquence, M4].
- **Débit [L, chiffres des en-têtes de migration du 03/11 et du post-mortem]** : 10 à 18 passes pdf par tick quand le pdf a toute la voie générale, dont 2 ventes terminées (scans, 2 à 6 min la passe) ; vidage : 43 ventes en 150 min, soit environ 2 par tick. Plafond : environ 4 ventes lues par tick, 110 par jour ; moitié moins avec l'alternance pdf et faits actuelle.
- **Arrivées [L + E]** : une lecture complète périme au bout de 24 h (`freshness.py:44, 199-203`) et la publication suivante crée une tâche pdf d'une nouvelle génération (`supabase_client.py:304, 327, 441-450` ; reproduit, cas H). Ordre de grandeur : une tâche par vente à pièces et par jour (1 317 pièces sur les ventes à venir, nombre de ventes à mesurer, M3). Le cache GitHub est borné à 300 Mo (`data-pipeline.yml:396`) : la revalidation retélécharge les fichiers. La file ne peut donc pas être vide, au mieux stable. Mesuré le 11/11 : +38 en attente et +7 en échec en une demi-journée.

## 2. « PDF document checkpoint was not persisted »

- **Où [L]** : texte nu levé en `queued_runner.py:716` ; ailleurs c'est un préfixe posé par `_pdf_checkpoint_failure_message` (l.430-433, appelé l.421, 884, 994, 1015) devant l'erreur d'origine quand le point d'étape renvoie faux. `tests/test_queued_runner.py:2339` fige ce comportement.
- **Prouvé [E]** : si la passe n'a rien lu et que rien n'était lu avant, la validation refuse avec `no_progress_entries` (`pdf_checkpoint_rules.py:196-198`) : il n'y a rien à écrire, le message masque la vraie cause. Trois cas reproduits : A, téléchargements en échec passager ; E, pièces hébergées par une source retirée dans une vente fusionnée, sautées sans rien consigner (`pdf_enrichment.py:449-453`) donc comptées en échec à chaque essai, sans fin ; F, plus de 6 pièces dont les 6 choisies d'abord répondent 404 : message nu, et boucle, car les URL définitivement perdues ne sont jamais enregistrées.
- **Écarté par le code [L]** : le cache GitHub. Le point d'étape lit le fichier écrit par la même passe (`pdf_enrichment.py:306-307`), les passes précédentes reviennent de la base (`queued_runner.py:677`). **Peu probable** : la garde de révision (`supabase_client.py:2028, 2055`), aucun déclencheur ne touche `updated_at` et le travailleur tient le verrou du catalogue. Un délai (5 s, 15 s, l.189-191) lèverait une exception journalisée « checkpoint failed ».
- **À mesurer** : M1 (répartition des 62 par suffixe et par hôte) et, dans le journal des runs, les lignes « PDF checkpoint refused for … : raison » (#423). Le post-mortem du 04/11 porte bien sur ce sujet (9 ventes sur 34) et son action 15, lire ces raisons, n'a jamais été faite.

## 3. Occupation hors liste et erreur de type : une seule cause [L + E]

`_clear_pdf_fact_projections` (`pdf_fact_scope.py:468-474, 500`) remet la valeur **brute** de `source_factual_snapshot` (`main.py:1269`, avant normalisation) et `_pdf_set_projected_value` (l.199-229) ne la normalise pas. Appelé à chaque relecture complète (`pdf_fact_extraction.py:108`).

- cessions_etat écrit `"libre"` brut (`cessions_etat_extraction.py:383`) : `occupancy_status = 'libre'`, hors liste, non rattrapé (`pdf_occupancy.py:107-108`).
- encheres_immobilieres écrit la surface en chaîne à virgule (`encheres_immobilieres.py:1142`) : `Decimal("85,5")` échoue, `parse_price` rejette tout nombre sous 100 (`normalize.py:300`), la chaîne reste et la comparaison suivante lève `'>' not supported between 'str' and 'int'`. Au-dessus de 100 la valeur est rattrapée, d'où la rareté.
- Correctif minimal : dans `_pdf_set_projected_value`, `normalize_occupancy_status` pour l'occupation, `parse_surface` puis `parse_decimal` pour un champ décimal, et vide plutôt que chaîne si rien ne se lit.

## 4. `download_status = 'unknown'` [L]

Un seul écrivain, `supabase_client.py:4309-4313` : `verified`, `downloaded`, sinon `unknown`, qui couvre jamais tenté, échec passager, échec définitif et pièce d'une source retirée. Colonne `text` sans contrainte. Les lecteurs savent déjà lire `blocked`, `failed`, `unavailable`, `not_found` (`document-extraction-summary.ts:13`, `listing-completeness.ts:1056`), que le pipeline n'écrit jamais. Proposition : `unknown` reste « jamais tenté » ; `not_found`, `blocked`, `unavailable` pour un échec définitif (déjà dans `permanent_document_failures`, `terminal_document_urls`, `blocked_document_urls` du manifeste) ; `retrying` pour un échec passager (neutre pour les lecteurs actuels, alors que `failed` s'afficherait comme définitif) ; motif et date du dernier essai dans `raw_payload.download`. Pas de reprise des 1 072 lignes de ventes passées.

## 5. Les autres files

- **`source_detail` [L]** : une tâche par vente et par source toutes les 23 h, 5 h à moins de 7 jours (migration 20260913081411:28-47) : quelques centaines en attente est l'état normal. Une tâche déjà en file dont la source est ensuite désactivée, suspendue ou retirée n'est plus prenable (`state.enabled`, migration 20260929220000:131-133) et n'est jamais annulée (l.51-90). Une tâche du 16/09 est donc très probablement garée, pas oubliée, mais elle ne partira jamais seule [S, M5]. Effet de bord : elle compte dans l'estimation des voies (`queued_runner.py:1425-1443`) et pousse le cycle à 3 pour 1.
- **`display_description` [L]** : plus aucun créateur (migration 20261112110000), fermées sans appel (`queued_runner.py:595-603`). Les 328 sont un reliquat retenu derrière la tâche pdf de leur vente : du bruit, pas un retard.
- **`fact_extraction` [L]** : retenues par la même garde et par le budget IA de 5 par jour (`pipeline_usage.py:32, 49`) : retard réel mais voulu, en partie conséquence de la file pdf.

## 6. Correctifs, dans l'ordre

| #   | Priorité   | Fichier, fonction                                                                          | Correctif                                                                                                                                            | Effort | Test à écrire                                                            | Risque                                                                         |
| --- | ---------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 1   | Critique   | `pdf_fact_scope.py`, `_pdf_set_projected_value`                                            | Normaliser la valeur restaurée (point 3)                                                                                                             | S      | « libre » rend `vacant` ; « 85,5 » rend un décimal ; illisible rend vide | Faible                                                                         |
| 2   | Critique   | `queued_runner.py`, `_pdf_checkpoint_failure_message` et l.683-721, 955-1024               | Ne plus préfixer quand il n'y a rien à écrire ; garder l'erreur d'origine et ajouter la raison du refus                                              | S      | Cas A et F ; adapter `test_queued_runner.py:2339`                        | Change le texte lu par `is_refused_checkpoint` (`document_backlog.py:261-272`) |
| 3   | Critique   | `pdf_enrichment.py:449-453`, `pdf_document_selection.py` `_store_document_analysis_status` | Pièce d'une source retirée : écartée avec motif, pas en échec                                                                                        | M      | Cas D et E terminent ; retrait levé, la pièce redevient à lire           | Pièce oubliée après levée du retrait si le test manque                         |
| 4   | Important  | `pdf_checkpoint_rules.py:196-200`                                                          | Accepter un point d'étape sans texte quand la passe a soldé des URL définitives                                                                      | M      | Cas F : le 2e essai choisit les pièces suivantes                         | Touche une validation stricte                                                  |
| 5   | Important  | `queued_runner.py:945-950, 1162-1168`                                                      | Budget IA épuisé : ne plus priver les tâches pdf (donner le temps restant au vidage, sans SQL)                                                       | M      | Budget épuisé, une tâche pdf est encore traitée                          | Durée du tick                                                                  |
| 6   | Important  | `queued_runner.py:820, 1025`                                                               | `upsert` rend 0 quand la garde de révision écarte l'écriture (`supabase_client.py:901-903`) : aujourd'hui la tâche est marquée terminée. La reporter | S      | Écriture écartée, tâche remise en file                                   | Faible                                                                         |
| 7   | Important  | `supabase_client.py:4309-4313`                                                             | Statuts du point 4                                                                                                                                   | S à M  | Un cas par statut ; lecteurs TS inchangés                                | Faible                                                                         |
| 8   | Important  | `freshness.py:44, 199-203`                                                                 | Fraîcheur d'une pièce lue et inchangée : 72 h ou 7 j au lieu de 24 h                                                                                 | M      | Cas H à 25 h reste à jour                                                | Changement de pièce vu plus tard                                               |
| 9   | Suggestion | `queued_runner.py:629-635`                                                                 | Vente entièrement retirée : annuler la tâche au lieu d'un report de 24 h sans fin                                                                    | S      | Tâche annulée, recréée à la levée                                        | Faible                                                                         |
| 10  | Suggestion | `queued_runner.py:1425-1443`                                                               | Estimation des voies : ignorer les `source_detail` non prenables                                                                                     | S      | Source désactivée, cycle 1 pour 1                                        | Faible                                                                         |

- **Sans décision du propriétaire** : 1, 2, 3, 4, 6, 7, 9, 10 (code et tests seulement).
- **Avec décision** : 8 (fraîcheur contre charge sur les sites sources) ; 5 si l'on préfère une famille « pdf » dans la fonction SQL de prise (migration) ; fermer les 328 `display_description` et les `source_detail` garées (écritures en base) ; relever le budget IA de 5 par jour pour les 251 passes de faits (coût du modèle).
- **Vider le retard, moyen déjà prévu** : entrée `documents_backlog` du workflow (`data-pipeline.yml:46-54, 308-313`, runbook `vidage-des-pieces.md`, « Retour à la normale ») : 200 ventes et 120 min par défaut, 150 au plus, groupe de concurrence à part, verrou pris par vente, réarme les tâches épuisées, mêmes règles robots et 2 s par hôte. Coût : 2 h à 2 h 30 de runner par vidage ; référence 43 ventes en 150 min sans lecture en avance, donc 2 à 6 vidages pour environ 250 tâches (rendement avec 3 processus jamais mesuré). La lecture IA qui suit (40 ventes, 20 min, `document_backlog.py:813-831`) puise dans le plafond commun de 5 par jour : pas de surcoût, mais elle peut l'épuiser et fermer la voie générale jusqu'à minuit UTC (correctif 5). À ne lancer qu'après 1 à 3, sinon il réarme chaque jour des échecs certains.

## Les 3 points les plus urgents

1. Correctif 1 : cause prouvée des 4 échecs d'occupation et de type, qui se reproduit à chaque relecture complète d'une vente concernée.
2. Mesure M1, puis correctifs 2 et 3 : le message masque la cause des 62 échecs ; les pièces de sources retirées et les pièces 404 bouclent sans fin.
3. Décision sur la fraîcheur de 24 h (correctif 8) et correctif 5 : sans eux, les arrivées dépassent le débit quel que soit le vidage.

## Mesures de production (lecture seule, comptages, sans `statement_timestamp`)

```sql
-- M1 Les 62 échecs : famille de message, nombre d'erreurs, premier hôte en échec
select case when last_error ~ '^PDF document checkpoint was not persisted; retry required: Document extraction incomplete' then '1 rien de lu + extraction incomplete'
            when last_error ~ '^PDF document checkpoint was not persisted; retry required: ' then '2 refus + autre erreur'
            when last_error ~ '^PDF document checkpoint was not persisted; retry required$' then '3 manifeste partiel sans rien de lisible'
            when last_error ~ '^Document extraction incomplete' then '4 incomplete, point d etape ecrit' else '5 autre' end as famille,
       (regexp_match(last_error, '(\d+) extraction errors'))[1] as erreurs,
       (regexp_match(last_error, 'failed documents \(([^/ ,)]+)'))[1] as hote,
       count(*) as taches, count(*) filter (where attempt_count >= max_attempts) as epuisees
from public.auction_enrichment_jobs where job_type = 'pdf' and status = 'failed' group by 1, 2, 3 order by 4 desc;

-- M2 Les tâches pdf en attente : dues ou reportées, et pourquoi ; par source et état de la source
select (j.next_attempt_at <= now()) as due, j.attempt_count, left(coalesce(j.last_error, '(jamais prise)'), 60) as dernier_message,
       s.source_name, st.enabled, st.catalogue_withdrawn, count(*) as taches,
       count(*) filter (where j.created_at < now() - interval '4 days') as anciennes
from public.auction_enrichment_jobs j join public.auction_sales s on s.source_url = j.source_url
left join public.auction_source_state st on st.source_name = s.source_name
where j.job_type = 'pdf' and j.status = 'queued' group by 1, 2, 3, 4, 5, 6 order by 7 desc;

-- M3 Arrivées et sorties par jour (8 jours)
select created_at::date as jour, count(*) as creees, count(*) filter (where status = 'completed') as terminees,
       count(*) filter (where status = 'cancelled') as annulees, count(*) filter (where status in ('queued','failed')) as ouvertes,
       count(distinct source_url) as ventes
from public.auction_enrichment_jobs where job_type = 'pdf' and created_at >= now() - interval '8 days' group by 1 order by 1;

-- M4 Ticks des dernières 24 h et reports pour budget IA
select count(*) as runs, count(*) filter (where status = 'succeeded') as reussis,
       round(avg((summary->>'execution_seconds')::numeric)) as duree_moyenne_s,
       sum((summary->>'enrichment_jobs_completed')::int) as taches_terminees,
       count(*) filter (where summary->>'document_backlog_exit_code' is null) as ticks_sans_vidage
from public.auction_runs where source = 'enrichment-queue' and started_at >= now() - interval '24 hours';
select date_trunc('hour', updated_at) as heure, count(*) as reports_budget
from public.auction_enrichment_jobs where status = 'queued' and last_error ilike '%budget%'
  and updated_at >= now() - interval '48 hours' group by 1 order by 1;

-- M5 source_detail : garées ou en retard ; description et faits : retenues par une tâche pdf
select j.detail_source_name, st.enabled, st.catalogue_withdrawn, (st.suspended_until > now()) as suspendue,
       count(*) as en_attente, count(*) filter (where j.next_attempt_at <= now()) as dues,
       count(*) filter (where j.created_at < now() - interval '48 hours') as plus_de_48h, min(j.created_at)::date as plus_ancienne
from public.auction_enrichment_jobs j left join public.auction_source_state st on st.source_name = j.detail_source_name
where j.job_type = 'source_detail' and j.status = 'queued' group by 1, 2, 3, 4 order by 5 desc;
select j.job_type, count(*) as en_attente, count(*) filter (where j.next_attempt_at > now()) as reportees,
       count(*) filter (where exists (select 1 from public.auction_enrichment_jobs p where p.source_url = j.source_url
         and p.job_type = 'pdf' and p.status in ('queued','running','failed')
         and (p.status = 'running' or p.attempt_count < p.max_attempts))) as retenues_par_pdf
from public.auction_enrichment_jobs j
where j.job_type in ('display_description','fact_extraction') and j.status = 'queued' group by 1;

-- M6 Pièces « unknown » des ventes à venir, par état de lecture
select coalesce(d.extraction_status, 'pending') as lecture, count(*)
from public.auction_documents d join public.auction_sales s on s.source_url = d.source_url
where d.download_status = 'unknown' and s.status in ('active','upcoming','postponed','unknown')
  and (s.sale_date is null or s.sale_date >= now()) group by 1 order by 2 desc;
```

Lecture attendue : M1 famille 1 ou 3 majoritaire confirme le point 2 (hôte `vench.fr` ou `petitesaffiches.fr` avec 0 erreur = cas E ; erreurs supérieures à 0 = téléchargements). M2 : anciennes non dues avec un message de retrait ou d'autorisation = boucle de 24 h ; anciennes dues = manque de prises (point c, à croiser avec M4).

## Fichiers

- Essais (hors dépôt) : `/tmp/claude-0/-home-user-immojudis/b7491545-da88-513a-b162-0678bf40ae93/scratchpad/r6-documents/repro_restauration.py` (point 3), `/tmp/claude-0/-home-user-immojudis/b7491545-da88-513a-b162-0678bf40ae93/scratchpad/r6-documents/test_sim_checkpoint.py` (cas A à H), `/tmp/claude-0/-home-user-immojudis/b7491545-da88-513a-b162-0678bf40ae93/scratchpad/r6-documents/pytest-complet.log`.
- `/home/user/immojudis/services/data-pipeline/src/queued_runner.py`, `/home/user/immojudis/services/data-pipeline/src/autonomous_runner.py`, `/home/user/immojudis/services/data-pipeline/src/document_backlog.py`, `/home/user/immojudis/services/data-pipeline/src/pdf_fact_scope.py`, `/home/user/immojudis/services/data-pipeline/src/pdf_enrichment.py`, `/home/user/immojudis/services/data-pipeline/src/pdf_document_selection.py`, `/home/user/immojudis/services/data-pipeline/src/pdf_occupancy.py`, `/home/user/immojudis/services/data-pipeline/src/pdf_fact_extraction.py`, `/home/user/immojudis/services/data-pipeline/src/freshness.py`, `/home/user/immojudis/services/data-pipeline/src/normalize.py`, `/home/user/immojudis/services/data-pipeline/src/main.py`, `/home/user/immojudis/services/data-pipeline/src/pipeline_usage.py`, `/home/user/immojudis/services/data-pipeline/src/source_withdrawal.py`
- `/home/user/immojudis/services/data-pipeline/src/storage/supabase_client.py`, `/home/user/immojudis/services/data-pipeline/src/storage/pdf_checkpoint_rules.py`, `/home/user/immojudis/services/data-pipeline/src/sources/cessions_etat_extraction.py`, `/home/user/immojudis/services/data-pipeline/src/sources/encheres_immobilieres.py`, `/home/user/immojudis/services/data-pipeline/tests/test_queued_runner.py`
- `/home/user/immojudis/.github/workflows/data-pipeline.yml`, `/home/user/immojudis/docs/audits/2026-11-04-post-mortem-vidage-pieces.md`, `/home/user/immojudis/docs/runbooks/vidage-des-pieces.md`
- `/home/user/immojudis/supabase/migrations/20260929220000_optimize_enrichment_claim_materialized_retention.sql`, `/home/user/immojudis/supabase/migrations/20261111050000_enrichment_claim_pdf_first.sql`, `/home/user/immojudis/supabase/migrations/20261111070000_enrichment_claim_pdf_head_start_24h.sql`, `/home/user/immojudis/supabase/migrations/20260913081411_recurring_source_detail_jobs.sql`, `/home/user/immojudis/supabase/migrations/20261112110000_stop_display_description_jobs.sql`
- `/home/user/immojudis/src/lib/document-extraction-summary.ts`, `/home/user/immojudis/src/lib/listing-completeness.ts`
