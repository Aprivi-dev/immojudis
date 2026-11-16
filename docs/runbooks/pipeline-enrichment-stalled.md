# Alertes `pipeline.enrichment.stalled` et `pipeline.enrichment.exhausted` (avertissements)

## `stalled`

Depuis `20261201100000`, l'alerte signale un **blocage** de la file d'enrichissement
(`auction_enrichment_jobs`), et non plus son âge : avec une file de plus de 1 000 tâches et un débit inférieur
à la file, « une tâche de plus de 24 h » était toujours vraie. Elle s'ouvre dans l'un de ces deux cas :

- **(a) bail expiré** (`expired_lease_24h`) : une tâche `running` dont le bail de 30 minutes a expiré depuis
  plus de 24 h (`coalesce(locked_at, updated_at)` de plus de 24 h 30), budget IA atteint ou non. La revendication
  aurait dû la reprendre : voir « Tâche `running` jamais reprise » plus bas.
- **(b) file qui ne bouge plus** : des tâches **prenables** restent non servies depuis plus de **72 h**
  (`unserved_72h`), **et** leur nombre n'a pas baissé depuis l'observation `enrichment-queue` d'il y a au moins
  24 h (`unserved_72h_24h_before`, prise à `unserved_72h_compared_at`). Une file longue qui avance n'ouvre rien ;
  sans observation de comparaison (premier jour après la migration), (b) n'ouvre rien non plus.

« Prenable » est la colonne `claimable` de l'observateur, les mêmes conditions que la revendication : vente
gardée (échéance de conservation matérialisée et non dépassée), révision la plus récente, source active et non
suspendue pour une tâche `source_detail`, aucun bail en cours sur la vente. « Non servie » : ni la dernière
écriture (`updated_at`) ni l'échéance (`next_attempt_at`) ne datent de moins de 72 h. Une description ou une
passe de faits qui attend la lecture des pièces de sa vente (tâche `pdf` encore en cours) n'est jamais comptée.

Les mesures précédentes restent dans les détails et dans l'observation, pour comparaison : `older_than_24h`
(tâches créées il y a plus de 24 h), `immobile_24h` (même définition que (a) et (b) avec 24 h au lieu de 72 h,
sans tendance), `claimable_due`, `excluded_due`, `backlog`.

### Report voulu par le budget IA

Le budget IA du jour (`LLM_DAILY_BUDGET_EUR` côté collecte, `daily_ai_budget_usd` côté contrôle du pilote) fait
reporter les tâches qui utilisent l'IA : le travailleur les remet en file avec l'erreur « Daily … budget
exhausted », rend la tentative et fixe la prochaine à minuit UTC (`defer_budget_jobs`). Après le premier refus du
jour, il ne prend plus que des tâches `source_detail` (`_run_enrichment_queue_worker`). Quand une tâche a été
reportée dans les 24 h (`budget_limited`), le cas (b) ne compte donc que les tâches `source_detail` ; le cas (a)
compte toujours. La mesure reste visible dans `auction_pipeline_observations` (`source_name = 'enrichment-queue'`,
`budget_deferred_24h`).

Un retard structurel dû au budget ne s'alerte pas ; il se décide : relever `daily_ai_budget_usd` (route
d'administration du pilote) ou accepter l'attente.

### Diagnostic

1. `select details from operational_alerts where alert_key = 'pipeline.enrichment.stalled';`
   (`expired_lease_24h`, `unserved_72h`, `unserved_72h_24h_before`, `budget_limited`, `claimable_due`).
2. Tendance de la file :
   `select observed_at, metrics->'unserved_72h', metrics->'claimable_due', metrics->'backlog' from
auction_pipeline_observations where source_name = 'enrichment-queue' order by observed_at desc limit 96;`
3. Tâches comptées, en lecture seule (le cas, et ce qui rend une tâche prenable) :

```sql
select j.id, j.job_type, j.status, j.attempt_count, j.max_attempts, j.next_attempt_at, j.locked_at, j.updated_at,
       case when j.status = 'running' then 'a' else 'b' end as cas,
       j.status <> 'running' and j.job_type <> 'source_detail' as ne_compte_pas_sous_budget,
       s.status as sale_status, s.retention_deadline_materialized, s.retention_deadline,
       exists (
         select 1
           from public.auction_enrichment_jobs pdf
          where pdf.source_url = j.source_url
            and pdf.job_type = 'pdf'
            and pdf.status in ('queued', 'running', 'failed')
            and (pdf.status = 'running' or pdf.attempt_count < pdf.max_attempts)
       ) and j.job_type in ('display_description', 'fact_extraction') as attend_les_pieces
  from public.auction_enrichment_jobs j
  left join public.auction_sales s on s.source_url = j.source_url
 where (
         j.status = 'running'
         and coalesce(j.locked_at, j.updated_at) < now() - interval '24 hours 30 minutes'
       )
    or (
         j.status in ('queued', 'failed')
         and j.attempt_count < j.max_attempts
         and j.next_attempt_at <= now()
         and greatest(j.updated_at, j.next_attempt_at) < now() - interval '72 hours'
       )
 order by j.updated_at;
```

4. `claimable_due = 0` et `excluded_due > 0` : les tâches échues ne peuvent pas être prises (vente expirée,
   source désactivée ou suspendue, `source_details_enabled` faux). Corriger la condition, pas la file.
5. `claimable_due > 0` et rien ne bouge : le travailleur ne tourne pas ; voir le workflow `data-pipeline.yml`
   et `pipeline.scheduler.disabled`. Des runs `enrichment-queue` en `failed_before_start` : voir « Échec avant
   démarrage » dans `docs/runbooks/pipeline-source-missed.md`.
6. Le travailleur tourne mais une voie n'avance pas : lire « Équité de la file » ci-dessous.

### Tâche `running` jamais reprise (cas (a))

La revendication (`claim_auction_enrichment_jobs_family`) reprend une tâche `running` dont le bail de 30 minutes
a expiré, avec une tentative de plus, et la passe en `failed` à sa dernière tentative (test
`supabase/tests/898_enrichment_claim_reclaims_expired_lease.sql`). Une tâche reprise est classée comme une tâche
en file : elle n'a aucune priorité propre. Une lecture de pièces restée en `running` depuis le 11/11/2026 n'a
pas été reprise ; selon le code de la revendication, seules quatre raisons l'expliquent, que la requête suivante
départage (lecture seule) :

```sql
select j.id, j.attempt_count, j.max_attempts, j.next_attempt_at, j.locked_at, j.created_at,
       j.next_attempt_at <= now() as echue,
       j.attempt_count < j.max_attempts as essais_restants,
       s.status as sale_status, s.retention_deadline_materialized, s.retention_deadline,
       coalesce(
         s.status in ('active', 'unknown', 'upcoming', 'postponed', 'past')
           and s.retention_deadline_materialized
           and (s.retention_deadline is null or s.retention_deadline > now()),
         false
       ) as vente_prenable,
       exists (
         select 1
           from public.auction_enrichment_jobs other
          where other.source_url = j.source_url
            and other.id <> j.id
            and other.status = 'running'
            and coalesce(other.locked_at, other.updated_at) >= now() - interval '30 minutes'
       ) as autre_bail_en_cours,
       (
         select count(*)
           from public.auction_enrichment_jobs o
           join public.auction_sales os on os.source_url = o.source_url
          where o.job_type <> 'source_detail'
            and o.status in ('queued', 'failed')
            and o.next_attempt_at <= now()
            and o.attempt_count < o.max_attempts
            and o.priority + extract(epoch from now() - o.created_at) / 3600
                + case when o.job_type = 'pdf' then 24 else 0 end
                + case when os.sale_date between now() and now() + interval '7 days' then 168 else 0 end
              > j.priority + extract(epoch from now() - j.created_at) / 3600 + 24
                + case when s.sale_date between now() and now() + interval '7 days' then 168 else 0 end
       ) as taches_devant
  from public.auction_enrichment_jobs j
  left join public.auction_sales s on s.source_url = j.source_url
 where j.job_type = 'pdf'
   and j.status = 'running'
   and coalesce(j.locked_at, j.updated_at) < now() - interval '24 hours';
```

- `essais_restants` faux : la revendication de la voie générale l'aurait passée en `failed` ; elle n'a donc
  pas tourné du tout (travailleur arrêté, ou seule la voie `source_detail` est prise : budget IA atteint dès le
  début de chaque passage).
- `echue` faux : une échéance future a été écrite sur une tâche `running` (aucune écriture de ce genre n'existe
  dans `services/data-pipeline/src/` aujourd'hui : chercher une écriture manuelle).
- `vente_prenable` faux avec `retention_deadline_materialized` faux : la vente est gardée par prudence (la
  tâche n'est pas annulée) mais jamais prenable tant que son échéance de conservation n'est pas matérialisée.
  Corriger la matérialisation, pas la tâche.
- `autre_bail_en_cours` vrai : une autre tâche de la même vente renouvelle sans cesse son bail.
- Tout est vrai et `taches_devant` est grand : la tâche attend simplement son tour dans la voie générale
  (classement ci-dessous) ; c'est un problème de débit.

Tant qu'elle reste en `running`, la description et les faits de sa vente l'attendent (la garde compte une tâche
`pdf` `running` quel que soit son bail). Ne pas la modifier par son identifiant sans avoir établi la cause.

### Équité de la file

Le travailleur alterne deux voies, réparties côté Python (`_enrichment_family_cycle` dans
`services/data-pipeline/src/queued_runner.py`) : `source_detail` (collecte des fiches) et `enrichment` (pièces,
faits, descriptions). Trois tâches `source_detail` pour une générale, ou une sur deux quand la file générale est
plus longue ; après le premier refus du budget IA, plus aucune générale jusqu'à la fin du passage. Une
description et une tâche `source_detail` ne sont donc jamais classées l'une contre l'autre par la base.

Dans la voie générale, la revendication classe par score : `priority` + **âge en heures** (sans plafond) + 24 si
`pdf` + 168 si la vente a lieu dans les 7 jours. Une tâche qui attend finit donc par passer devant : une
description vieille de 15 jours (360 points d'âge) passe devant une lecture de pièces du jour (24 points). Une
description ou une passe de faits n'est en revanche jamais prise tant que la tâche `pdf` de sa vente peut encore
avancer : une description « jamais touchée » attend le plus souvent sa lecture de pièces. Requête de contrôle :

```sql
select j.job_type,
       exists (
         select 1 from public.auction_enrichment_jobs pdf
          where pdf.source_url = j.source_url and pdf.job_type = 'pdf'
            and pdf.status in ('queued', 'running', 'failed')
            and (pdf.status = 'running' or pdf.attempt_count < pdf.max_attempts)
       ) as attend_les_pieces,
       count(*), min(j.updated_at)
  from public.auction_enrichment_jobs j
 where j.status in ('queued', 'failed') and j.job_type in ('display_description', 'fact_extraction')
 group by 1, 2;
```

## `exhausted`

Une tâche `failed` dont `attempt_count >= max_attempts` n'est plus jamais prise (lettre morte). L'alerte s'ouvre
quand :

- au moins **greatest(10, 2 % de la file vivante)** tâches sont devenues épuisées dans les dernières 24 h
  (`exhausted_24h`) ; la file vivante est `backlog` moins les tâches épuisées. Avec ~1 280 tâches vivantes, le
  seuil est 26. Avant `20261201100000`, il était de 3 : six épuisements en un jour sur plus de 1 000 tâches
  ouvraient l'alerte ;
- ou au moins **50** tâches épuisées attendent une décision (`exhausted`).

Les seuils appliqués sont dans les détails : `exhausted_24h_threshold` (seuil calculé), `exhausted_24h_minimum`,
`exhausted_24h_queue_share`, `exhausted_threshold`. Un report par le budget ne consomme pas de tentative : cette
alerte ne vient jamais du budget. Procédure de traitement manuel : `docs/pipeline-reliability.md`, section « Jobs
d'enrichissement épuisés ».

## Fermeture

Automatique, deux heures après le retour à la normale. Acquitter à la main n'a pas de sens : tant que la
condition est vraie, le passage suivant la rouvre.
