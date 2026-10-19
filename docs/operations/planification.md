# Inventaire des tâches planifiées

Mis à jour le 19 octobre 2026. Toute route `src/app/api/cron/*` doit figurer ici, dans `vercel.json`
ou dans une migration `pg_cron` ; le test `src/lib/scheduled-jobs.test.ts` le vérifie.

## Tâches applicatives (routes `/api/cron/*`)

| Tâche                                                      | Système            | Horaire (UTC)           | Route / script                        | Supervisée                                           | Seuil d'alerte (`cron.stale`) |
| ---------------------------------------------------------- | ------------------ | ----------------------- | ------------------------------------- | ---------------------------------------------------- | ----------------------------- |
| Évaluation des alertes                                     | Vercel Cron        | 06:15, rattrapage 08:15 | `/api/cron/smart-alerts`              | oui                                                  | pas de succès depuis 30 h     |
| Envoi des alertes                                          | Vercel Cron        | 06:30, rattrapage 08:30 | `/api/cron/alert-notifications`       | oui                                                  | 30 h                          |
| Suivi des changements                                      | Vercel Cron        | 06:45, rattrapage 08:45 | `/api/cron/sale-change-monitor`       | oui                                                  | 30 h                          |
| Rappels d'audience et avertissements graves                | Vercel Cron        | 07:15, rattrapage 09:15 | `/api/cron/sale-reminders`            | oui                                                  | 30 h                          |
| Rétention des données                                      | Vercel Cron        | dimanche 04:15          | `/api/cron/data-retention`            | oui                                                  | 8 jours                       |
| Complétude des annonces (palier de classement de /sales)   | Supabase `pg_cron` | toutes les heures à :20 | `/api/cron/listing-completeness`      | oui                                                  | 3 h                           |
| Complétude des annonces (filet quotidien)                  | Vercel Cron        | 05:50 tous les jours    | `/api/cron/listing-completeness`      | oui (même tâche, même seuil)                         | 3 h                           |
| Santé opérationnelle                                       | Supabase `pg_cron` | toutes les 15 min       | `/api/cron/operational-health`        | oui                                                  | 45 min                        |
| Purge des ventes                                           | Supabase `pg_cron` | toutes les 5 min        | `/api/cron/sale-retention`            | oui                                                  | 20 min                        |
| Pré-calcul des valorisations                               | Supabase `pg_cron` | toutes les 5 min        | `/api/cron/precompute-valuations`     | non (déclenchement géré par la file de valorisation) | —                             |
| Réponses de l'agent (lecture seule, n'envoie aucun e-mail) | Supabase `pg_cron` | toutes les 2 min        | `/api/cron/information-agent-inbound` | oui                                                  | 10 min                        |

La complétude des annonces est recalculée par lots de 300 ventes (variable
`LISTING_COMPLETENESS_BATCH_LIMIT`) : 24 passages par jour couvrent 7 200 évaluations pour environ
1 950 ventes en ligne, soit une réévaluation quotidienne de chacune (les ventes jamais évaluées,
modifiées ou évaluées avec une autre version de la règle passent en premier). Le job
`immojudis-listing-completeness` réutilise l'origine et le Bearer déjà dans Supabase Vault
(`npm run ops:health-scheduler:configure`), sans nouveau secret. Tant qu'il n'a jamais réussi,
`cron.stale` signale la tâche : une alerte transitoire est attendue jusqu'au premier succès après
le déploiement.

Si plus de 3 h séparent l'application de la migration `20261024100100` et le déploiement du code
(qui porte la route), `cron.stale` ouvre une alerte critique : le job Supabase appelle une route
qui n'existe pas encore. Il suffit alors d'appeler la route une fois, avec `CRON_SECRET`
(`Authorization: Bearer $CRON_SECRET` sur `/api/cron/listing-completeness`), pour la refermer.

Les rappels d'audience (J-7, J-1) et les avertissements graves (date modifiée, vente retirée,
reportée ou adjugée) passent après le suivi des changements, dont ils lisent les événements. Ils sont
pilotés par la variable `SALE_REMINDERS_MODE` : `off` (défaut, rien n'est lu ni envoyé, le passage
réussit quand même), `internal` (seulement aux administrateurs ayant consenti, objet « [Test
interne] », pour mesurer les fausses alertes dans le journal `sale_reminder_dispatches`), `on`
(toutes les personnes ayant consenti). Une valeur inconnue vaut `off`. Le consentement est distinct de
celui des alertes (`/compte`, rubrique Notifications) et la case n'est proposée que dans les modes
qui envoient. Le journal garantit qu'un même rappel ne part jamais deux fois et se purge au-delà de
180 jours. La tâche exige les variables d'envoi des alertes (`RESEND_API_KEY`, `ALERT_EMAIL_FROM`,
`SITE_URL`) : sans elles le passage réussit sans rien envoyer (`skipped: not_configured`).

Les quatre tâches Vercel quotidiennes ont un second passage deux heures plus tard : il ne fait rien
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
| Check Pending Supabase Migrations         | planifié (tous les jours 07:10 UTC)      | échec = migrations de `main` non appliquées en production            |
