# Inventaire des tâches planifiées

Mis à jour le 26 octobre 2026. Toute route `src/app/api/cron/*` doit figurer ici, dans `vercel.json`
ou dans une migration `pg_cron` ; le test `src/lib/scheduled-jobs.test.ts` le vérifie.

## Tâches applicatives (routes `/api/cron/*`)

| Tâche                                                      | Système            | Horaire (UTC)           | Route / script                        | Supervisée                                           | Seuil d'alerte (`cron.stale`) |
| ---------------------------------------------------------- | ------------------ | ----------------------- | ------------------------------------- | ---------------------------------------------------- | ----------------------------- |
| Évaluation des alertes                                     | Vercel Cron        | 06:15, rattrapage 08:15 | `/api/cron/smart-alerts`              | oui                                                  | pas de succès depuis 27 h     |
| Envoi des alertes                                          | Vercel Cron        | 07:30, rattrapage 09:30 | `/api/cron/alert-notifications`       | oui                                                  | 27 h                          |
| Suivi des changements                                      | Vercel Cron        | 06:45, rattrapage 08:45 | `/api/cron/sale-change-monitor`       | oui                                                  | 27 h                          |
| Rappels d'audience et avertissements graves                | Vercel Cron        | 07:15, rattrapage 09:15 | `/api/cron/sale-reminders`            | oui                                                  | 27 h                          |
| Alertes de résultat ou de remise en vente                  | Vercel Cron        | 10:15                   | `/api/cron/sale-results`              | journal d'exécution seulement                        | pas encore                    |
| Récapitulatif hebdomadaire « Ma semaine »                  | Vercel Cron        | 11:30                   | `/api/cron/weekly-digest`             | journal d'exécution seulement                        | pas encore                    |
| Rétention des données                                      | Vercel Cron        | dimanche 04:15          | `/api/cron/data-retention`            | oui                                                  | 8 jours                       |
| Complétude des annonces (palier de classement de /sales)   | Supabase `pg_cron` | toutes les heures à :20 | `/api/cron/listing-completeness`      | oui                                                  | 3 h                           |
| Complétude des annonces (filet quotidien)                  | Vercel Cron        | 05:50 tous les jours    | `/api/cron/listing-completeness`      | oui (même tâche, même seuil)                         | 3 h                           |
| Pépites des ventes (règle `pepite-v1`, mode `shadow`)      | Supabase `pg_cron` | toutes les heures à :35 | `/api/cron/sale-pepites`              | oui                                                  | 3 h                           |
| Pépites des ventes (filet quotidien)                       | Vercel Cron        | 05:42 tous les jours    | `/api/cron/sale-pepites`              | oui (même tâche, même seuil)                         | 3 h                           |
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

Le calcul des pépites (route `/api/cron/sale-pepites`, règle `pepite-v1`, migrations `20261104100000` et
`20261104100100`) tourne chaque heure à :35, par lots de 300 ventes (variable `SALE_PEPITES_BATCH_LIMIT`) :
une vente jamais évaluée, modifiée, dont l'estimation a été recalculée, évaluée avec une autre version de la
règle, du moteur de plafond ou d'un régime, ou évaluée il y a plus de 24 h, est (ré)évaluée. Le mode
(`app_private.sale_pepite_settings`) vaut `shadow` à l'application de la migration : les résultats sont
calculés et stockés, rien n'est visible du public (les fonctions publiques ne rendent rien) ; `off` arrête le
calcul ; `on` ouvre la lecture publique (décision du fondateur, après contrôle de la liste de `/admin/pepites`) ; l'ouverture se fait par une migration dédiée. Un administrateur peut repasser de `on` à `shadow` avec le bouton « Suspendre les pépites » de `/admin/pepites` (fonction `suspend_sale_pepites`, qui ne sait jamais ouvrir).
Avant la migration, la route se termine sans rien faire (`skipped: not_migrated`). Même mécanisme Vault que la
complétude, sans nouveau secret. Ordre de mise en production : code, puis migrations. La migration
`20261104100100` lance elle-même le premier calcul à sa dernière instruction
(`select app_private.invoke_sale_pepites_endpoint();`, appel `pg_net` asynchrone) : plus d'appel manuel de la route
nécessaire quand les secrets Vault sont configurés ; sans secret, l'appel ne fait rien (avertissement) et la
première passe horaire, à :35, prend le relais. `cron.stale` signale la tâche tant qu'elle n'a jamais réussi (voir
« Ajouter une tâche supervisée » ci-dessous). Toute redéfinition de `app_private.evaluate_operational_health` doit
garder `('sale-pepites', interval '3 hours')` dans sa liste de tâches attendues.

Les rappels d'audience (J-7, J-1) et les avertissements graves (date modifiée, vente retirée,
reportée ou adjugée) passent après le suivi des changements, dont ils lisent les événements. Ils sont
pilotés par la variable `SALE_REMINDERS_MODE` : `off` (défaut, rien n'est lu ni envoyé, le passage
réussit quand même), `internal` (seulement aux administrateurs ayant consenti, objet « [Test
interne] », pour mesurer les fausses alertes dans le journal `sale_reminder_dispatches`), `on`
(toutes les personnes ayant consenti). Une valeur inconnue vaut `off`. Le consentement est distinct de
celui des alertes (`/compte`, rubrique Notifications) et la case n'est proposée que dans les modes
qui envoient. Le journal garantit qu'un même rappel ne part jamais deux fois et se purge au-delà de
180 jours. La tâche exige les variables d'envoi des alertes (`RESEND_API_KEY`, `ALERT_EMAIL_FROM`,
`SITE_URL`) : sans elles le passage réussit sans rien envoyer (`skipped: not_configured`). Un J-7 ou
J-1 n'est envoyé que si la vente a été revérifiée à la source depuis moins de 36 h (`skippedStale` ;
le passage échoue au-delà de 20 % de rappels écartés), et seules les adresses email confirmées
reçoivent. Le suivi des changements examine chaque jour tous les comptes ayant consenti, en plus du
lot de `SALE_CHANGE_CRON_USER_LIMIT` comptes. Critère de passage à `on` :
`docs/runbooks/activation-rappels-audience.md`.

Deux emails s'ajoutent aux rappels, chacun avec son consentement distinct (jamais pré-coché, daté et
versionné par la base), son lien de désinscription signé (portée dédiée, valable un an) et son
interrupteur d'envoi, **fermé par défaut** : le propriétaire ne les ouvre qu'après la mise à jour de la
politique de confidentialité et du registre des traitements.

- **Alerte de résultat ou de remise en vente** (`SALE_RESULTS_MODE`, `/api/cron/sale-results`, 10:15) :
  quand une vente suivie a eu lieu (instantané après l'audience : « résultat connu » ou « résultat non
  connu », avec la mention de surenchère indicative) ou change de statut grave (adjugée, retirée ou
  annulée, remise en vente), un email renvoie vers la fiche ou « Mes favoris ». **Jamais de prix** (les
  instantanés sont lus sans leurs colonnes de prix). Pas de type « non adjugée » : aucune source ne le
  prouve. Elle passe après le suivi des changements et les rappels d'audience, et ne répète pas un
  avertissement (adjugée, retirée, annulée) que les rappels ont déjà journalisé. Journal
  `sale_result_dispatches` : un email par compte, vente et type. Valeurs : `off` (défaut), `internal`
  (administrateurs, objet « [Test interne] »), `on`.
- **Récapitulatif hebdomadaire « Ma semaine »** (`WEEKLY_DIGEST_MODE`, `/api/cron/weekly-digest`, 11:30) :
  un email par semaine, au jour choisi dans `/compte` (mardi par défaut) : audiences des 14 prochains
  jours (dates sourcées, revérifiées depuis moins de 36 h), changements des 7 derniers jours sur les
  ventes suivies, nouvelles ventes du département des alertes (sans alerte : bouton « Créer une alerte »).
  Rien à annoncer, pas d'email. **Au plus un email par compte et par jour** : le cron passe après les
  alertes, les rappels et les alertes de résultat ; si l'un d'eux est déjà parti ce jour-là au compte,
  le récapitulatif n'est pas fusionné avec lui, il est reporté au lendemain, puis au surlendemain, et
  la semaine est sautée au-delà. Journal `weekly_digest_dispatches` (unique par compte et semaine ISO).
  Le passage échoue quand un envoi est dû et que Resend n'est pas configuré.

Les journaux des deux emails sont purgés à 180 jours par `run_data_retention` (cron hebdomadaire),
même quand l'envoi est fermé. Les deux tâches ne sont pas encore dans la liste attendue de
`cron.stale` (`app_private.evaluate_operational_health`) : tant que les interrupteurs sont à `off`
elles réussissent sans rien faire ; les ajouter à la liste est une décision à prendre à l'ouverture
(procédure plus bas).

Les quatre tâches Vercel quotidiennes ont un second passage deux heures plus tard : il ne fait rien
si la tâche a déjà réussi dans les 20 dernières heures (`catchUpSchedule` de `runMonitoredCron`).
Chaque passage réessaie 3 fois (5 s, 20 s, 60 s) sur une erreur réseau ou 5xx.

## Plan Vercel Hobby : ordre des tâches et seuil de `cron.stale`

Sur le plan Hobby, un cron tombe à n'importe quel moment de l'heure demandée (jusqu'à 59 minutes de
décalage) : deux tâches de la même heure n'ont aucun ordre garanti. D'où :

- `alert-notifications` passe une heure entière après `smart-alerts` (06:15 puis 07:30 ; rattrapage 08:15
  puis 09:30), car elle envoie ce que `smart-alerts` prépare. Les notifications sont prévues à 07:00 UTC
  (`scheduledForFrequency`) : à 06:30 elles n'étaient pas encore échues et partaient le lendemain, avec
  près de 24 h de retard ; à 07:30 elles sont échues. `sale-reminders` (07:15) passe après
  `sale-change-monitor` (06:45) dont il lit les événements ;
- le seuil de `cron.stale` des quatre tâches quotidiennes est de **27 h** (il était de 30 h). Deux succès
  consécutifs d'une tâche quotidienne sont espacés de 24 h au plus ; si le passage de 06:xx échoue et que
  seul le rattrapage (2 h plus tard) réussit, l'écart monte à 27 h dans le pire cas de décalage Hobby
  (24 h + 3 h). 27 h signale donc un jour manqué 3 h plus tôt qu'avant, et n'est atteint sur un cycle sain
  qu'à la limite du pire cas (dans ce cas l'alerte se referme d'elle-même au succès suivant) ;
- les routes longues déclarent `maxDuration` (300 s : `smart-alerts`, `alert-notifications`,
  `sale-change-monitor`, `data-retention`, `listing-completeness`, `sale-retention`…).

## Ajouter une tâche supervisée : remise à zéro de `cron.stale`

Ajouter une tâche à la liste attendue de `cron.stale` (fonction `app_private.evaluate_operational_health`,
migration) ouvre aussitôt une alerte **critique** : la tâche n'a encore aucun succès enregistré. Le cas de
`sale-reminders` (liste modifiée par `20261028130200`, première exécution le 20/10/2026) a laissé l'alerte
ouverte jusqu'au premier passage de Vercel. Procédure :

1. Déployer le code qui porte la route **avant** (ou en même temps que) la migration, jamais après.
2. Juste après la migration, appeler la route une fois avec `Authorization: Bearer $CRON_SECRET` : le succès
   enregistré referme la détection au passage suivant de `operational-health` (15 min).
3. Il n'y a rien à remettre à zéro à la main : l'alerte reste ouverte tant que la détection est active, devient
   inactive (`inactive_since`) quand la tâche a réussi, et se ferme deux heures plus tard
   (`app_private.sync_operational_alert`). Ne pas supprimer la ligne d'`operational_alerts` : l'historique
   (`occurrence_count`, `first_seen_at`) et la notification de fermeture en dépendent.
4. Le test pgTAP 599 vérifie cette fermeture spontanée pour `sale-reminders`.

Pour une tâche réellement arrêtée, voir `docs/operations-phase-3.md` (`cron.stale`).

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

| Workflow                                  | Déclencheur                                               | Supervision                                                          |
| ----------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| Immojudis Data Pipeline (`data-pipeline`) | planifié + répartition par l'application                  | alertes `pipeline.source.*`, `pipeline.import.unhealthy`             |
| Recompute des ventes existantes           | manuel                                                    | verrou `immojudis-recompute` + verrou en base                        |
| DVF import                                | **manuel** (`workflow_dispatch`, aucun planning)          | alerte `dvf.freshness` (donnée de plus de 220 jours)                 |
| Information Agent Evidence                | planifié toutes les 30 min + manuel                       | analyse des pièces jointes privées de l'agent (OCR), lecture seule   |
| Production smoke                          | planifié toutes les 30 min + manuel                       | échec du workflow ; voir `docs/operations/supervision-externe.md`    |
| Immojudis Operational Alert               | déclenché par l'application                               | échec = incident ouvert ; avertissement = rappel ; vert = résolution |
| Entraînement du modèle de valorisation    | manuel                                                    | rapport JSON + tableau de synthèse                                   |
| Apply Supabase Migrations                 | manuel depuis `main`                                      | refuse si le CI du commit n'est pas vert ; contrôle de dérive        |
| Check Pending Supabase Migrations         | `push` sur `main` (migrations) + tous les jours 07:10 UTC | échec = migrations de `main` non appliquées en production            |
