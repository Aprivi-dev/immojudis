# Alertes `pipeline.enrichment.stalled` et `pipeline.enrichment.exhausted` (avertissements)

## `stalled`

Au moins une tâche d'enrichissement (`auction_enrichment_jobs` en `queued`, `running` ou `failed`, tentatives
restantes) date de plus de **24 heures**. Les tâches épuisées (échec, toutes les tentatives utilisées) n'en
font pas partie.

### Report voulu par le budget IA

Le budget IA du jour (5 $ ou EUR par jour : `LLM_DAILY_BUDGET_EUR` côté collecte, `daily_ai_budget_usd` côté contrôle du pilote) fait reporter les tâches
qui utilisent l'IA : le travailleur les remet en file (`queued`) avec l'erreur « Daily … budget exhausted »,
rend la tentative et fixe la prochaine à minuit UTC (`defer_budget_jobs`). Ce n'est pas un blocage. Depuis
`20261029170100`, dès qu'une telle tâche a été reportée dans les dernières 24 h (`budget_limited` dans
l'évidence), seules les tâches `source_detail` (collecte de fiche, sans IA) peuvent encore ouvrir l'alerte, avec
les tâches `running` dont le bail a expiré depuis 24 h (cas (a) ci-dessous).
La mesure reste visible dans `auction_pipeline_observations` (`source_name = 'enrichment-queue'`,
`budget_deferred_24h`).

Un retard structurel dû au budget (file plus grande que ce que 5 par jour peut lire) ne s'alerte plus ; il se
décide : relever `daily_ai_budget_usd` (route d'administration du pilote) ou accepter l'attente.

### Tâche immobile (`immobile_24h`, depuis `20261119101000`)

`immobile_24h` ouvre l'alerte à lui seul. Il additionne deux comptes :

- **(a) bail expiré** : une tâche `running` dont le bail de 30 minutes a expiré depuis plus de 24 h
  (`coalesce(locked_at, updated_at)` de plus de 24 h 30), **budget atteint ou non**. Cas d'origine : une lecture
  de pièces (`pdf`) restée en `running` depuis le 11/11, qui bloquait la description et les faits de sa vente.
- **(b) tâche prenable intacte** : une tâche que la revendication pourrait prendre maintenant (colonne
  `claimable` de l'observateur : vente gardée, révision la plus récente, source active, aucun bail en cours sur la
  vente), qui n'attend pas la lecture des pièces de sa vente (description et faits derrière une tâche `pdf`), et
  dont ni la dernière écriture (`updated_at`) ni l'échéance (`next_attempt_at`) ne datent de moins de 24 h.
  Chaque prise, fin ou report écrit `updated_at` : rien n'a touché cette tâche alors qu'elle était prenable depuis
  un jour. Un report programmé (minuit UTC, attente d'accès de 24 h, `Retry-After`) n'en est pas une tant que son
  échéance n'a pas 24 h. **Sous `budget_limited`, (b) ne compte que les tâches `source_detail`** : après le premier
  refus du budget, le travailleur ne prend plus que celles-là (`_run_enrichment_queue_worker`), et les autres
  attendent sans être touchées, ce qui est le report voulu décrit plus haut.

Une tâche retenue volontairement (attente des pièces, source désactivée ou suspendue, révision remplacée, vente
expirée ou dont l'échéance de conservation n'est pas matérialisée) n'est jamais immobile ; elle reste dans
`excluded_due`.

La revendication (`claim_auction_enrichment_jobs_family`) reprend une tâche `running` dont le bail de 30 minutes
a expiré, avec une tentative de plus, et la passe en `failed` à sa dernière tentative (test
`supabase/tests/898_enrichment_claim_reclaims_expired_lease.sql`). Requête de diagnostic, en lecture seule. Elle
montre les deux cas et ce qui rend une tâche prenable ; la colonne `ne_compte_pas_sous_budget` signale les tâches
que (b) ignore sous `budget_limited` :

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
         and greatest(j.updated_at, j.next_attempt_at) < now() - interval '24 hours'
       )
 order by j.updated_at;
```

Une ligne du cas (b) avec `attend_les_pieces` vrai, une vente expirée, une échéance de conservation non
matérialisée ou une source désactivée n'est pas comptée : seules les autres le sont.

Causes à vérifier, dans l'ordre :

- cas (a) : la revendication ne tourne plus (voir le point 3 du diagnostic), ou une session restée ouverte
  verrouille la ligne (`pg_locks`, `pg_stat_activity`) ;
- cas (b) : le travailleur ne tourne pas, ou la voie générale n'est jamais prise (`claimable_due` stable, runs
  `enrichment-queue` arrêtés avant leur première prise générale).

### Diagnostic

1. `select details from operational_alerts where alert_key = 'pipeline.enrichment.stalled';`
   (`backlog`, `older_than_24h`, `claimable_due`, `excluded_due`, `budget_limited`, `immobile_24h`).
2. `claimable_due = 0` et `excluded_due > 0` : les tâches échues ne peuvent pas être prises (vente expirée,
   source désactivée ou suspendue, `source_details_enabled` faux). Corriger la condition, pas la file.
3. `claimable_due > 0` et rien ne bouge : le travailleur ne tourne pas ; voir le workflow `data-pipeline.yml`
   et `pipeline.scheduler.disabled`. Des runs `enrichment-queue` en `failed_before_start` : le job échoue
   avant le pipeline, voir « Échec avant démarrage » dans `docs/runbooks/pipeline-source-missed.md`.
4. Tâches `source_detail` anciennes : la source concernée est-elle activée (`auction_source_state.enabled`) et
   non suspendue ?

## `exhausted`

Au moins 3 tâches sont devenues épuisées dans les dernières 24 h, ou au moins 50 attendent une décision.
Un report par le budget ne consomme pas de tentative : cette alerte ne vient jamais du budget. Procédure de
traitement manuel : `docs/runbooks/pipeline-autonomy-progress.md`, section « Jobs d'enrichissement épuisés ».

## Fermeture

Automatique, deux heures après le retour à la normale.
