# Inventaire des tâches planifiées

Mis à jour le 9 octobre 2026. Toute route `src/app/api/cron/*` doit figurer ici, dans `vercel.json`
ou dans une migration `pg_cron` ; le test `src/lib/scheduled-jobs.test.ts` le vérifie.

## Tâches applicatives (routes `/api/cron/*`)

| Tâche                        | Système            | Horaire (UTC)           | Route / script                        | Supervisée                                           | Seuil d'alerte (`cron.stale`) |
| ---------------------------- | ------------------ | ----------------------- | ------------------------------------- | ---------------------------------------------------- | ----------------------------- |
| Évaluation des alertes       | Vercel Cron        | 06:15, rattrapage 08:15 | `/api/cron/smart-alerts`              | oui                                                  | pas de succès depuis 30 h     |
| Envoi des alertes            | Vercel Cron        | 06:30, rattrapage 08:30 | `/api/cron/alert-notifications`       | oui                                                  | 30 h                          |
| Suivi des changements        | Vercel Cron        | 06:45, rattrapage 08:45 | `/api/cron/sale-change-monitor`       | oui                                                  | 30 h                          |
| Rétention des données        | Vercel Cron        | dimanche 04:15          | `/api/cron/data-retention`            | oui                                                  | 8 jours                       |
| Santé opérationnelle         | Supabase `pg_cron` | toutes les 15 min       | `/api/cron/operational-health`        | oui                                                  | 45 min                        |
| Purge des ventes             | Supabase `pg_cron` | toutes les 5 min        | `/api/cron/sale-retention`            | oui                                                  | 20 min                        |
| Pré-calcul des valorisations | Supabase `pg_cron` | toutes les 5 min        | `/api/cron/precompute-valuations`     | non (déclenchement géré par la file de valorisation) | —                             |
| Réponses de l'agent          | Supabase `pg_cron` | toutes les 2 min        | `/api/cron/information-agent-inbound` | oui                                                  | 10 min                        |

Les trois tâches Vercel quotidiennes ont un second passage deux heures plus tard : il ne fait rien
si la tâche a déjà réussi dans les 20 dernières heures (`catchUpSchedule` de `runMonitoredCron`).
Chaque passage réessaie 3 fois (5 s, 20 s, 60 s) sur une erreur réseau ou 5xx.

## Tâches volontairement manuelles

| Tâche                      | Déclenchement                                                       | Raison                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Annuaire des avocats (CNB) | Appel manuel de `/api/cron/cnb-lawyer-directory` avec `CRON_SECRET` | Décision antérieure : aucune planification concurrente de la collecte (voir `check-manual-data-collection.mjs`) ; le test pgTAP 382 impose qu'elle ne soit pas supervisée comme cron périodique. |

## Tâches de base de données uniquement (`pg_cron`)

| Tâche                                     | Horaire (UTC)        | Rôle                                                                    |
| ----------------------------------------- | -------------------- | ----------------------------------------------------------------------- |
| `immojudis-operational-history-retention` | tous les jours 03:35 | Purge de `cron.job_run_details` et de `operational_job_runs` (30 jours) |
| `immojudis-licitor-resume`                | désactivée           | Reprise de l'ingestion Licitor, volontairement arrêtée                  |

## Workflows GitHub Actions

| Workflow                                  | Déclencheur                              | Supervision                                                          |
| ----------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| Immojudis Data Pipeline (`data-pipeline`) | planifié + répartition par l'application | alertes `pipeline.source.*`, `pipeline.import.unhealthy`             |
| Recompute des ventes existantes           | manuel                                   | verrou `immojudis-recompute` + verrou en base                        |
| DVF import                                | planifié (annuel/semestriel)             | alerte `dvf.freshness`                                               |
| Immojudis Operational Alert               | déclenché par l'application              | échec = incident ouvert ; avertissement = rappel ; vert = résolution |
| Entraînement du modèle de valorisation    | manuel                                   | rapport JSON + tableau de synthèse                                   |
| Apply Supabase Migrations                 | manuel depuis `main`                     | contrôle de dérive du schéma                                         |
