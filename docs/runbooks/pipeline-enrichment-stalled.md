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
l'évidence), seules les tâches `source_detail` (collecte de fiche, sans IA) peuvent encore ouvrir l'alerte.
La mesure reste visible dans `auction_pipeline_observations` (`source_name = 'enrichment-queue'`,
`budget_deferred_24h`).

Un retard structurel dû au budget (file plus grande que ce que 5 par jour peut lire) ne s'alerte plus ; il se
décide : relever `daily_ai_budget_usd` (route d'administration du pilote) ou accepter l'attente.

### Diagnostic

1. `select details from operational_alerts where alert_key = 'pipeline.enrichment.stalled';`
   (`backlog`, `older_than_24h`, `claimable_due`, `excluded_due`, `budget_limited`).
2. `claimable_due = 0` et `excluded_due > 0` : les tâches échues ne peuvent pas être prises (vente expirée,
   source désactivée ou suspendue, `source_details_enabled` faux). Corriger la condition, pas la file.
3. `claimable_due > 0` et rien ne bouge : le travailleur ne tourne pas ; voir le workflow `data-pipeline.yml`
   et `pipeline.scheduler.disabled`.
4. Tâches `source_detail` anciennes : la source concernée est-elle activée (`auction_source_state.enabled`) et
   non suspendue ?

## `exhausted`

Au moins 3 tâches sont devenues épuisées dans les dernières 24 h, ou au moins 50 attendent une décision.
Un report par le budget ne consomme pas de tentative : cette alerte ne vient jamais du budget. Procédure de
traitement manuel : `docs/runbooks/pipeline-autonomy-progress.md`, section « Jobs d'enrichissement épuisés ».

## Fermeture

Automatique, deux heures après le retour à la normale.
