# Inventaire des tâches planifiées

Mis à jour le 9 octobre 2026. Toute route `src/app/api/cron/*` doit figurer ici, dans `vercel.json`
ou dans une migration `pg_cron` ; le test `src/lib/scheduled-jobs.test.ts` le vérifie.

## Tâches applicatives (routes `/api/cron/*`)

| Tâche                                                      | Système            | Horaire (UTC)           | Route / script                        | Supervisée                                           | Seuil d'alerte (`cron.stale`) |
| ---------------------------------------------------------- | ------------------ | ----------------------- | ------------------------------------- | ---------------------------------------------------- | ----------------------------- |
| Évaluation des alertes                                     | Vercel Cron        | 06:15, rattrapage 08:15 | `/api/cron/smart-alerts`              | oui                                                  | pas de succès depuis 30 h     |
| Envoi des alertes                                          | Vercel Cron        | 06:30, rattrapage 08:30 | `/api/cron/alert-notifications`       | oui                                                  | 30 h                          |
| Suivi des changements                                      | Vercel Cron        | 06:45, rattrapage 08:45 | `/api/cron/sale-change-monitor`       | oui                                                  | 30 h                          |
| Rétention des données                                      | Vercel Cron        | dimanche 04:15          | `/api/cron/data-retention`            | oui                                                  | 8 jours                       |
| Santé opérationnelle                                       | Supabase `pg_cron` | toutes les 15 min       | `/api/cron/operational-health`        | oui                                                  | 45 min                        |
| Purge des ventes                                           | Supabase `pg_cron` | toutes les 5 min        | `/api/cron/sale-retention`            | oui                                                  | 20 min                        |
| Pré-calcul des valorisations                               | Supabase `pg_cron` | toutes les 5 min        | `/api/cron/precompute-valuations`     | non (déclenchement géré par la file de valorisation) | —                             |
| Réponses de l'agent (lecture seule, n'envoie aucun e-mail) | Supabase `pg_cron` | toutes les 2 min        | `/api/cron/information-agent-inbound` | oui                                                  | 10 min                        |

Les trois tâches Vercel quotidiennes ont un second passage deux heures plus tard : il ne fait rien
si la tâche a déjà réussi dans les 20 dernières heures (`catchUpSchedule` de `runMonitoredCron`).
Chaque passage réessaie 3 fois (5 s, 20 s, 60 s) sur une erreur réseau ou 5xx.

## Tâches volontairement manuelles

| Tâche                             | Déclenchement                                                             | Raison                                                                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Demandes de l'agent d'information | Bouton « Valider et envoyer » de l'admin, fiche par fiche, après l'aperçu | Règle du propriétaire : aucun envoi ni relance automatique (voir `docs/runbooks/information-agent.md`, verrouillé par `information-agent-no-automatic-send.test.ts`).                            |
| Annuaire des avocats (CNB)        | Appel manuel de `/api/cron/cnb-lawyer-directory` avec `CRON_SECRET`       | Décision antérieure : aucune planification concurrente de la collecte (voir `check-manual-data-collection.mjs`) ; le test pgTAP 382 impose qu'elle ne soit pas supervisée comme cron périodique. |

## Tâches de base de données uniquement (`pg_cron`)

| Tâche                                     | Horaire (UTC)        | Rôle                                                                    |
| ----------------------------------------- | -------------------- | ----------------------------------------------------------------------- |
| `immojudis-operational-history-retention` | tous les jours 03:35 | Purge de `cron.job_run_details` et de `operational_job_runs` (30 jours) |
| `immojudis-licitor-resume`                | désactivée           | Ancienne reprise de l'ingestion Licitor, remplacée (voir ci-dessous)    |

L'historique des adjudications Licitor est collecté automatiquement depuis le 12/10/2026 (décision
du propriétaire), sans cron supplémentaire : après chaque passage de la file d'enrichissement, le
lanceur planifié (`autonomous_runner`) exécute un « tick » borné du collecteur
(`src.sources.licitor_history_refresh` : au plus 100 requêtes, 2 s entre deux, robots.txt respecté,
rôle `licitor_collector` posé par `set local role` dans chaque transaction, jamais au niveau de la
session : le pooler en mode transaction transmettrait le rôle à d'autres clients, incident du
12/10/2026), puis atteste les nouveaux lots par la porte structurelle des statistiques
(`app_private.attest_licitor_reported_candidates`). La campagne mensuelle (36 mois, 90 derniers jours
relus) est créée au premier tick du mois. Son code de sortie est noté dans `auction_runs.summary`
(`licitor_history_exit_code`).

## Workflows GitHub Actions

| Workflow                                  | Déclencheur                              | Supervision                                                          |
| ----------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| Immojudis Data Pipeline (`data-pipeline`) | planifié + répartition par l'application | alertes `pipeline.source.*`, `pipeline.import.unhealthy`             |
| Recompute des ventes existantes           | manuel                                   | verrou `immojudis-recompute` + verrou en base                        |
| DVF import                                | planifié (annuel/semestriel)             | alerte `dvf.freshness`                                               |
| Immojudis Operational Alert               | déclenché par l'application              | échec = incident ouvert ; avertissement = rappel ; vert = résolution |
| Entraînement du modèle de valorisation    | manuel                                   | rapport JSON + tableau de synthèse                                   |
| Apply Supabase Migrations                 | manuel depuis `main`                     | contrôle de dérive du schéma                                         |
