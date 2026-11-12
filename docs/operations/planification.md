# Inventaire des tâches planifiées

Mis à jour le 11 novembre 2026 (contrôle quotidien du registre des pièces ; auparavant, le 10 novembre :
analyse des réponses de l'agent déclenchée à la réception ;
auparavant, le 31 octobre : cadences réelles des tâches `pg_cron` et seuils de `cron.stale` alignés dessus,
`sale-results` et `weekly-digest` supervisées ; auparavant : règle de répartition entre les trois planificateurs,
filets quotidiens sans effet quand `pg_cron` a réussi, inventaire des workflows GitHub planifiés). Toute route `src/app/api/cron/*` doit figurer
ici, dans `vercel.json` ou dans une migration `pg_cron`, et tout workflow GitHub qui a un `schedule` doit figurer
dans le tableau des workflows ; le test `src/lib/scheduled-jobs.test.ts` le vérifie.

## Qui déclenche quoi : la règle

Trois systèmes savent lancer une tâche. Chacun a un rôle, et une nouvelle tâche suit cette règle (à vérifier en
revue) :

| Système                     | Rôle                                                                                                                                                                                                                                                                                                    | Pourquoi                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Supabase `pg_cron`          | **Horloge** de tout ce qui tourne plusieurs fois par jour ou dépend d'un ordre précis (tick toutes les 2, 5 ou 15 min, chaque heure à une minute donnée ; depuis le 30/10/2026 le passage réel est plus rare, voir « Cadences réelles »). Il appelle une route `/api/cron/*` avec les secrets de Vault. | Seul planificateur gratuit précis à la minute et sans limite de fréquence.                                                |
| Vercel Cron (`vercel.json`) | Tâches **quotidiennes** (emails, purge) et **filets** quotidiens des tâches de `pg_cron`.                                                                                                                                                                                                               | Le plan Hobby n'autorise qu'un passage par jour et par entrée, à n'importe quel moment de l'heure demandée.               |
| GitHub Actions              | Travail **long** (plus de 5 min : collecte, imports, entraînement) ou que la source refuse depuis Vercel (Géorisques). Lancé **sur demande** (`workflow_dispatch`) par l'application ou la base, jamais sur horaire pour une tâche métier.                                                              | Les horaires GitHub ne sont pas tenus : 44 passages au lieu d'environ 355 du 20 au 27/10/2026 (`supervision-externe.md`). |

Un **filet** est un second déclencheur de la même tâche par un autre chemin. Il ne fait rien quand le chemin
principal a réussi récemment (`catchUpSchedule` de `runMonitoredCron`, qui lit l'en-tête
`x-vercel-cron-schedule` envoyé par Vercel) : il ne sert que si ce chemin est en panne (secret Vault perdu, `pg_cron`
arrêté). Un appel de `pg_cron` n'a pas cet en-tête et s'exécute toujours.

Les workflows GitHub qui gardent un `schedule` sont des **contrôles** (test de fumée, migrations en attente,
CodeQL, horloge décalée du pipeline), à une exception près, l'analyse des réponses de l'agent d'information :
elle est déclenchée par la passe des réponses dès qu'une analyse attend, et son horaire GitHub n'est plus qu'un
filet (voir la fin de ce document). La liste est figée dans `scheduled-jobs.test.ts` : en
ajouter un demande de modifier ce test, donc une décision explicite.

La supervision de toute cette chaîne passe elle-même par `pg_cron` → Vercel → GitHub
(`operational-health`) : seule une sonde extérieure à ces trois services voit sa panne. Elle est à poser par le
propriétaire (`supervision-externe.md`, « Poser la sonde ») ; tant qu'elle n'existe pas, une panne de cette chaîne
reste silencieuse.

## Tâches applicatives (routes `/api/cron/*`)

| Tâche                                                                                                               | Système            | Horaire (UTC)                                                                | Route / script                          | Supervisée                                           | Seuil d'alerte (`cron.stale`) |
| ------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------- | ----------------------------- |
| Évaluation des alertes                                                                                              | Vercel Cron        | 06:15, rattrapage 08:15                                                      | `/api/cron/smart-alerts`                | oui                                                  | pas de succès depuis 27 h     |
| Envoi des alertes                                                                                                   | Vercel Cron        | 07:30, rattrapage 09:30                                                      | `/api/cron/alert-notifications`         | oui                                                  | 27 h                          |
| Suivi des changements                                                                                               | Vercel Cron        | 06:45, rattrapage 08:45                                                      | `/api/cron/sale-change-monitor`         | oui                                                  | 27 h                          |
| Rappels d'audience et avertissements graves                                                                         | Vercel Cron        | 07:15, rattrapage 09:15                                                      | `/api/cron/sale-reminders`              | oui                                                  | 27 h                          |
| Alertes de résultat ou de remise en vente                                                                           | Vercel Cron        | 10:15                                                                        | `/api/cron/sale-results`                | oui                                                  | 27 h                          |
| Récapitulatif hebdomadaire « Ma semaine »                                                                           | Vercel Cron        | 11:30 (chaque jour ; l'envoi suit le jour choisi)                            | `/api/cron/weekly-digest`               | oui                                                  | 8 jours                       |
| Email de fin d'essai gratuit (J+5)                                                                                  | Vercel Cron        | 12:30, rattrapage 14:30                                                      | `/api/cron/trial-end-email`             | journal d'exécution seulement                        | pas encore                    |
| Rétention des données                                                                                               | Vercel Cron        | dimanche 04:15                                                               | `/api/cron/data-retention`              | oui                                                  | 8 jours                       |
| Complétude des annonces (palier de classement de /sales)                                                            | Supabase `pg_cron` | toutes les heures à :20                                                      | `/api/cron/listing-completeness`        | oui                                                  | 3 h                           |
| Complétude des annonces (filet quotidien)                                                                           | Vercel Cron        | 05:50, sans effet si `pg_cron` a réussi dans les 2 h                         | `/api/cron/listing-completeness`        | oui (même tâche, même seuil)                         | 3 h                           |
| Risque d'inondation des ventes (règle `pepite-v2`)                                                                  | Supabase `pg_cron` | tick à :25 de chaque heure, passage toutes les 2 h                           | `/api/cron/sale-flood-risk`             | oui                                                  | 5 h                           |
| Risque d'inondation des ventes (filet quotidien)                                                                    | Vercel Cron        | 05:35, sans effet si la passe a réussi dans les 2 h                          | `/api/cron/sale-flood-risk`             | oui (même tâche, même seuil)                         | 5 h                           |
| Pépites des ventes (règle `pepite-v1.1` ou `pepite-v2`)                                                             | Supabase `pg_cron` | toutes les heures à :35                                                      | `/api/cron/sale-pepites`                | oui                                                  | 3 h                           |
| Pépites des ventes (filet quotidien)                                                                                | Vercel Cron        | 05:42, sans effet si `pg_cron` a réussi dans les 2 h                         | `/api/cron/sale-pepites`                | oui (même tâche, même seuil)                         | 3 h                           |
| Rapprochement Stripe / droits (lecture seule)                                                                       | Vercel Cron        | 05:20, sans effet si Stripe n'est pas configuré                              | `/api/cron/billing-reconciliation`      | journal d'exécution, alerte dédiée à chaque écart    | pas encore                    |
| Contrôle du registre des pièces (alertes `fact_registry.*` ; relance planifiée de la projection, fermée par défaut) | Vercel Cron        | 05:28, sans effet tant que la migration `20261117100500` n'est pas appliquée | `/api/cron/fact-registry-check`         | oui                                                  | 27 h                          |
| Résumé quotidien des réponses à relire                                                                              | Vercel Cron        | 07:05, sans rattrapage                                                       | `/api/cron/replies-review-digest`       | journal d'exécution seulement                        | pas encore                    |
| Santé opérationnelle                                                                                                | Supabase `pg_cron` | tick toutes les 15 min, passage toutes les 30 min                            | `/api/cron/operational-health`          | oui                                                  | 65 min                        |
| Purge des ventes                                                                                                    | Supabase `pg_cron` | tick toutes les 5 min, passage toutes les 15 min                             | `/api/cron/sale-retention`              | oui                                                  | 35 min                        |
| Pré-calcul des valorisations                                                                                        | Supabase `pg_cron` | tick toutes les 5 min, passage si dossier dû, sinon 1 h                      | `/api/cron/precompute-valuations`       | non (déclenchement géré par la file de valorisation) | —                             |
| Réponses de l'agent (lecture seule, n'envoie aucun e-mail)                                                          | Supabase `pg_cron` | tick toutes les 2 min, passage si message dû, sinon 8 min                    | `/api/cron/information-agent-inbound`   | oui                                                  | 25 min                        |
| Pilote automatique de l'agent (désactivé par défaut ; envoi réel bloqué)                                            | Supabase `pg_cron` | toutes les 10 min, appel HTTP seulement si le mode n'est pas « off »         | `/api/cron/information-agent-autopilot` | non (le pilote n'a pas de cadence de rattrapage)     | 20 min                        |

### Cadences réelles des tâches `pg_cron` et seuils de `cron.stale`

Depuis la migration `20261110100713` (30/10/2026), le tick de `pg_cron` ne change pas, mais la fonction appelée par
chaque tâche (`app_private.cron_dispatch_due`) ne fait l'appel HTTP à Vercel que s'il y a du travail ou si un
passage de contrôle est dû. « Dû » se lit dans `public.operational_job_runs` : un passage **réussi ou en cours**
(`app_private.cron_job_started_since`) compte, un passage **échoué** non (migration `20261110120100`) : après un
échec, la tâche est relancée au premier tick qui suit un délai minimal de 5 minutes après la fin du passage échoué
(`app_private.cron_job_failed_since`), sans attendre la fin de la fenêtre.

| Tâche                       | Tick `pg_cron` | Garde   | Cadence réelle (sans travail en file) | Durée max d'un passage | Seuil `cron.stale` |
| --------------------------- | -------------- | ------- | ------------------------------------- | ---------------------- | ------------------ |
| `operational-health`        | 15 min         | 25 min  | 30 min                                | 5 min                  | 65 min             |
| `sale-retention`            | 5 min          | 14 min  | 15 min (5 min tant qu'il reste)       | 5 min                  | 35 min             |
| `information-agent-inbound` | 2 min          | 6 min   | 8 min (2 min si un message est dû)    | 5 min                  | 25 min             |
| `sale-flood-risk`           | 1 h (à :25)    | 110 min | 2 h                                   | 10 min                 | 5 h                |

**Règle pour un seuil** : seuil ≥ 2 × cadence réelle + durée d'un passage (un passage manqué ne suffit pas à
alerter, deux oui). La cadence réelle est un peu plus longue que la garde quand le tick tombe pile sur la fin
de la fenêtre (le début enregistré d'un passage suit de quelques secondes le tick) : c'est le cas de
`information-agent-inbound` (garde 6 min, tick 2 min, donc 8 min). Les tâches horaires (`listing-completeness`,
`sale-pepites`) gardent 3 h, les tâches quotidiennes de Vercel 27 h, `data-retention` 8 jours. Le seuil de
`operational-health` est aussi dans `src/lib/health-status.ts` (`HEALTH_OPERATIONAL_MAX_AGE_MINUTES`, 65) :
changer l'un change l'autre. Si l'on change une garde (`cron_dispatch_due`), refaire ce calcul.

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

Le calcul des pépites (route `/api/cron/sale-pepites`, règles `pepite-v1.1` et `pepite-v2`, migrations
`20261104100000` et `20261104100100`) tourne chaque heure à :35, par lots de 300 ventes (variable
`SALE_PEPITES_BATCH_LIMIT`) : une vente jamais évaluée, modifiée, dont l'estimation a été recalculée, évaluée avec
une autre version de la règle, du moteur de plafond ou d'un régime, ou évaluée il y a plus de 24 h, est
(ré)évaluée. Le mode (`app_private.sale_pepite_settings`) valait `shadow` à l'application de la migration ; il vaut
`on` depuis le 26/10/2026 (migration `20261105100000`, décision du fondateur) : les fonctions publiques rendent les
pépites publiables. `off` arrête le calcul ; `shadow` calcule et stocke sans rien montrer ; l'ouverture se fait par
une migration dédiée. Un administrateur peut repasser de `on` à `shadow` avec le bouton « Suspendre les pépites » de
`/admin/pepites` (fonction `suspend_sale_pepites`, qui ne sait jamais ouvrir ; procédure :
`docs/runbooks/pepites-arret-urgence.md`).
Passage à `pepite-v1.1` (27/10/2026, n° 20 à 26) : la version de règle stockée change, donc chaque pépite publiée est
réévaluée en priorité au premier passage horaire qui suit le déploiement, puis les autres ventes par lots de 300 ;
une pépite qui ne remplit plus les critères corrigés sort à ce passage. La migration `20261108140000` (versions du
modèle de valeur dans la pépite, colonnes d'instantané) s'applique AVANT le déploiement du code : sinon le calcul
retente son écriture sans les deux nouvelles colonnes. Protocole de mesure du label :
`docs/operations/suivi-justesse-pepite.md`.
Avant la migration, la route se termine sans rien faire (`skipped: not_migrated`). Même mécanisme Vault que la
complétude, sans nouveau secret. Ordre de mise en production : code, puis migrations. La migration
`20261104100100` lance elle-même le premier calcul à sa dernière instruction
(`select app_private.invoke_sale_pepites_endpoint();`, appel `pg_net` asynchrone) : plus d'appel manuel de la route
nécessaire quand les secrets Vault sont configurés ; sans secret, l'appel ne fait rien (avertissement) et la
première passe horaire, à :35, prend le relais. `cron.stale` signale la tâche tant qu'elle n'a jamais réussi (voir
« Ajouter une tâche supervisée » ci-dessous). Toute redéfinition de `app_private.evaluate_operational_health` doit
garder `('sale-pepites', interval '3 hours')` **et** `('sale-flood-risk', interval '5 hours')` dans sa liste de tâches
attendues (la seconde, ajoutée par la migration `20261106100300` avec 3 h puis portée à 5 h par `20261110120100`, ne doit pas être perdue par une redéfinition ultérieure). La liste compte treize tâches depuis `20261110120200` : voir « Ajouter une tâche supervisée ».

## Règle `pepite-v1.2` : marché local, coût énergétique, taille et copropriété (validée le 29/10/2026)

La règle `pepite-v1.2` remplace `pepite-v1.1` comme règle appliquée interrupteur fermé ; `PEPITE_RULE_V2_ENABLED` ouvre
désormais `pepite-v2.1` (= `pepite-v1.2` + le critère d'inondation de `pepite-v2`). `pepite-v1`, `pepite-v1.1` et
`pepite-v2` restent rejouables. Les seuils des tests B et C ne changent pas. Elle lit en plus le DPE
(`auction_dpe_diagnostics`, puis l'annonce), les pièces lues (`auction_document_readings`) et l'agrégat du marché local
`app_private.commune_market_trends`, recalculé depuis `dvf_transactions`.

**Ordre de mise en production** (aucune étape n'est automatique) :

1. Appliquer les migrations `20261109130000` (enregistre la construction de l'index
   `dvf_transactions_insee_type_sale_date_idx`) et `20261109130100` (table, recalcul et lecture de l'agrégat), puis
   construire l'index : `npm run db:indexes:concurrent` (aussi lancé par le workflow « Apply Supabase Migrations »),
   hors collecte en cours.
2. Premier calcul de l'agrégat : `select app_private.refresh_commune_market_trends();` (précédé de
   `set local statement_timeout = '10min'` dans la même transaction). Ensuite, le workflow manuel « Immojudis DVF
   Import » le recalcule à la fin de son étape d'import (`python -m src.dvf_market_trends`), et le workflow manuel « Refresh commune market trends » le recalcule seul (premier calcul compris), sans nouvelle planification.
3. Déployer le code : la version appliquée devient `pepite-v1.2`, chaque pépite publiée est réévaluée en priorité au
   premier passage horaire et sort si elle ne remplit plus les critères (DPE F ou G, marché peu liquide ou en baisse,
   bien de plus de 250 m² ou de plus de 1 500 000 €, copropriété en difficulté). Renseigner alors
   `PEPITE_V1_2_EFFECTIVE_DATE` (`src/app/methode-pepites/method.ts`).

Sans agrégat (migration absente, commune sans vente), les critères de marché sont réussis : déployer avant l'étape 2
n'exclut rien. Un import DVF « replace_existing » remplace la table : l'importeur construit l'index sur la table de
chargement avant l'échange (`services/data-pipeline/src/dvf_import.py`, `STAGING_INDEX_SUFFIXES`), il survit donc au
remplacement. Un test vérifie que tout index de `dvf_transactions` construit par le script d'index l'est aussi par
l'importeur.

## Règle `pepite-v2` : risque d'inondation, mise en production en deux temps

La règle `pepite-v2` ajoute à `pepite-v1.1` un critère éliminatoire : un bien dont la position précise est dans la zone
du scénario « forte probabilité » (crue fréquente) d'un TRI n'est pas une pépite (compte-rendu
`docs/equipe/2026-10-26-pepite-v2-inondation-loyers.md`). Elle est livrée **derrière un interrupteur serveur,
fermé par défaut**.

**Étape 1 : alimenter et calibrer (interrupteur fermé).** La règle appliquée reste `pepite-v1.1` : le calcul des pépites
ne lit pas la table d'inondation, aucun résultat ne change, `/admin/pepites` affiche « Règle pepite-v1.1 ». Le traitement
d'inondation, lui, tourne :

- `/api/cron/sale-flood-risk` (pg_cron à :25, filet Vercel quotidien à 05:35, lots de 150 ventes, variable
  `SALE_FLOOD_RISK_BATCH_LIMIT`) observe les ventes à venir et écrit un verdict par vente dans la table privée
  `auction_sale_flood_risk` (migration `20261106100200`) :
  - position précise (adresse, parcelle) : API Géorisques `tri_zonage` au point, puis périmètre d'un PPRi (servitude
    PM1 du Géoportail de l'urbanisme, API Carto, `code_alea` 11). Parcelle multiple : chaque centroïde est testé
    (au plus 5) ; `high` si tous sont dans la zone, `unknown` si les résultats divergent. Une rue : le point et
    quatre points d'un tampon de 100 m, mais **seul `high` est retenu** (le point BAN d'une rue peut être à plus de
    700 m du numéro), tout autre résultat donne `unknown` (règle `flood-v2`, n° 39) ;
  - position imprécise (centre de commune, précision absente, drapeau `unverified_source_coordinates`,
    `implausible_coordinates` ou `geocode_outside_department`, lieu-dit de la BAN, numéro de la BAN dont le score
    est inférieur à 0,8) : **aucun appel de position**, seulement « la commune compte-t-elle un TRI ? » (GASPAR,
    gardé par commune 24 h) ; commune avec TRI : `unknown` (aucune nouvelle pépite) ; sans TRI : `no_signal` ;
  - cadence de 2 à 3 appels par seconde, tous services confondus ; **un 429 arrête la passe** (coupe-circuit) ; une
    passe qui n'obtient aucune observation échoue (donc `cron.stale` après 3 h) ;
  - rafraîchissement : tous les 90 jours et dès que la position ou sa précision change ; une tentative en échec est
    retentée après 6 h ; **un verdict connu n'est jamais écrasé par « inconnu » après une panne** ; la dernière valeur
    valable reste utilisée 180 jours ;
  - **périmètre des PPRi illisible** (PM1 en panne) : le verdict « aucun risque élevé » est écrit avec `ppri_checked`
    faux (nouvel essai après 6 h) ; la fiche affiche alors une ligne neutre (« périmètres de PPRi non contrôlés à ce
    jour ») et **aucune nouvelle pépite n'entre** tant que le périmètre n'est pas lu. Un verdict « exposé » connu (ou un
    « aucun risque élevé » lu en entier) pour la même position **n'est jamais écrasé** par un demi-contrôle : seule la
    tentative est consignée (`last_failure = ppri_unreadable`) ;
  - **une seule passe à la fois** : bail `sale_flood_risk_lease` (migration `20261106100500`, fonctions
    `claim_sale_flood_risk_lease` / `release_sale_flood_risk_lease`). Le bail est pris par un seul `UPDATE` (le verrou de
    ligne sérialise les demandes simultanées), expire seul au bout de 6 minutes si la passe meurt, et une seconde passe
    simultanée (pg_cron à :25 et filet de 05:35, ou rejeu manuel) rend `skipped: "busy"`. Un verrou consultatif de
    session (`pg_try_advisory_lock`) ne convient pas : le traitement parle à la base par appels PostgREST séparés,
    sans session commune ; le modèle est celui de `claim_autonomous_pipeline_run`. Sans la migration, la passe continue
    sans verrou (ordre de déploiement tolérant) ;
  - **temps borné** : `maxDuration` de la route = 300 s ; aucune sonde ne démarre s'il reste moins de 40 s (échéance à
    260 s, contrôlée avant chaque point testé, une rue en compte cinq) ; chaque appel (TRI, GASPAR, PM1) est coupé à 8 s ;
    les verdicts sont écrits par paquets de 25 ventes pendant la passe ; toute redirection est refusée
    (`redirect: "error"`) ;
  - rien n'est journalisé qui contienne une coordonnée, une URL d'appel ou une réponse de la source (seuls des codes :
    `http_503`, `timeout`, `ppri_unreadable`…) ; la table ne copie aucune coordonnée : la position n'y figure que sous
    la forme d'une empreinte tronquée, c'est une pseudonymisation (pas une anonymisation).
- **depuis le 27/10/2026, les appels partent de GitHub Actions** : Géorisques coupe les connexions qui viennent de
  Vercel (`network_econnreset` sur toutes les ventes). La route `/api/cron/sale-flood-risk` (pg*cron à :25, filet
  de 05:35) ne fait plus que **déclencher** le workflow `sale-flood-risk.yml` (`workflow_dispatch`, même jeton
  GitHub que le pipeline), suivi sous le nom `sale-flood-risk-dispatch`. Le workflow exécute
  `src/jobs/sale-flood-risk-runner.ts` (`npm run flood-risk:build`), qui appelle le même `runSaleFloodRiskBatch`
  (bail, cadence, paquets) et se supervise sous le nom `sale-flood-risk`, celui de `cron.stale`. La taille de lot
  est la variable de dépôt GitHub `SALE_FLOOD_RISK_BATCH_LIMIT`. `SALE_FLOOD_RISK_RUNNER=vercel` (Vercel,
  redéploiement) rétablit les appels depuis la route. Diagnostic des pannes (table des codes `network*\_`,
`http\_\_`, `timeout`, `ppri_unreadable`, `write_busy_N`) : `docs/runbooks/georisques-pannes-inondation.md` ;
- le code commune de chaque vente (`auction_sale_communes`, migrations `20261106100000` et `20261106100100`) vient du
  pipeline (`raw_payload.commune`, `services/data-pipeline/src/commune_insee.py`) et est recopié par le même
  traitement ; les arrondissements de Paris, Lyon et Marseille sont ramenés à 75056, 69123 et 13055 pour GASPAR, le
  code de l'arrondissement est gardé à part.
- migrations, dans l'ordre : `20261106100000` (table des communes), `20261106100100` (remplissage initial en SQL pur,
  sans appel externe), `20261106100200` (table d'inondation), `20261106100300` (pg_cron :25 et `cron.stale`),
  `20261106100400` (fonction publique des pépites « exposées »), `20261106100500` (bail du traitement). Ordre de mise en production : code, puis migrations,
  puis un appel de `/api/cron/sale-flood-risk` avec `CRON_SECRET` (voir « Ajouter une tâche supervisée »). La dernière
  instruction de `20261106100300` lance elle-même un premier passage (`pg_net`, asynchrone).

**Dossier du terrain (rapport foncier).** Pour une position « commune » (centre de commune ou coordonnées absentes), la
couche TRI du dossier garde une information **au niveau de la commune** (GASPAR `gaspar/tri`, constat « Commune comprise
dans un territoire à risque important d'inondation », qui ne dit pas si le bien est dans la zone) au lieu de « non
vérifiée ». Écart connu : en mode **v2** de l'API Géorisques (jeton `GEORISQUES_API_TOKEN` présent), aucune opération
`tri_zonage` ni `gaspar/tri` n'est publiée dans l'OpenAPI v2 : la couche TRI y reste « non vérifiée » (le dossier ne
mélange pas les deux versions), quelle que soit la position. Le contrôle des pépites, lui, appelle toujours l'API v1.

**Étape 2 : calibrer.** Mesurer sur le catalogue réel la part des pépites publiées qui ont un verdict
(`auction_sale_flood_risk` joint à `auction_sale_pepites`, lectures bornées et indexées) et relire à la main une
quarantaine de ventes à position précise sur Géorisques et le Géoportail de l'urbanisme (proposition n° 7).

**Étape 3 : bascule** (procédure et prérequis mesurés : `docs/runbooks/pepite-v2-ouverture.md`). Un seul geste : définir **`PEPITE_RULE_V2_ENABLED=true`** dans l'environnement du serveur
(Vercel, Production), puis redéployer. La variable, comme `SALE_FLOOD_RISK_BATCH_LIMIT`, est lue par le circuit de
configuration commun (`src/lib/env.ts`, comme `SALE_REMINDERS_MODE`). Tant que la variable est absente ou autre chose que `true` / `1`, la règle
appliquée est `pepite-v1.1`. À la bascule :

- le calcul des pépites lit le verdict stocké de chaque vente (sans table ou sans communes : `skipped:
not_migrated`, rien n'est écrit) ; toutes les ventes sont réévaluées (la version de règle change), les pépites déjà
  publiées en premier, et une pépite publiée dont le verdict change passe en priorité 0 ;
- un risque **élevé** est un signal bloquant : il fait sortir une pépite publiée immédiatement, même gelée à J-7 ;
- un verdict **inconnu** empêche l'entrée d'une nouvelle pépite mais **ne fait jamais sortir** une pépite publiée
  (elle reste affichée jusqu'à la vente, la fiche l'indique) ;
- le verdict « exposé » (périmètre d'un PPRi) n'exclut pas : il s'affiche, partout où le badge Pépite apparaît (fiche,
  cartes de liste, carte), par la mention « zonage à vérifier » (fonction publique
  `list_public_pepite_flood_exposed_ids`, sans montant) ;
- la page de méthode `/methode-pepites` décrit alors la règle `pepite-v2` (sections « Le risque d'inondation »,
  garde-fous, historique des versions, sources) ; renseigner `PEPITE_V2_EFFECTIVE_DATE` dans
  `src/app/methode-pepites/method.ts` à la date de bascule.

**Retour arrière** : retirer `PEPITE_RULE_V2_ENABLED` (ou le mettre à `false`) et redéployer : la règle `pepite-v1.1`
est rejouée telle quelle (table figée de `src/lib/pepite-policy.characterization.test.ts`), les pépites sorties pour
risque élevé redeviennent éligibles à l'évaluation suivante. Le traitement d'inondation peut continuer à tourner.

Le registre des traitements (`docs/rgpd-processing-register.md`), la matrice de conservation
(`docs/data-retention-matrix.md`), la politique de confidentialité et les mentions légales décrivent l'envoi des
coordonnées d'une vente à Géorisques (BRGM) et à l'API Carto (IGN) ; ils doivent être à jour avant le premier appel
réel.

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

- **Email de fin d'essai gratuit** (`TRIAL_END_EMAIL_MODE`, `/api/cron/trial-end-email`, 12:30) : un seul
  email par compte, à J+5 après la confirmation de l'adresse (l'essai dure 7 jours), sans pression : ce qui
  reste gratuit, ce qui se ferme, rien ne devient payant, lien « Être prévenu de l'ouverture ». Ni email à J+1
  ni rappel. La file est `get_trial_end_notice_queue` (essai qui se termine dans les 2 jours, hors
  administrateurs, abonnés et désinscrits) ; le journal est `launch_offer_end_notices` (clé : compte et jour
  de Paris de la fin d'essai), la désinscription `launch_offer_end_notice_optouts` (lien signé en un clic,
  aussi en `List-Unsubscribe`). Valeurs : `off` (défaut, rien n'est lu ni envoyé), `internal` (un message
  d'exemple « [Test interne] » par administrateur et par jour, aucun compte réel), `on`. À n'ouvrir
  qu'après relecture du texte et du registre des traitements par `juridique-rgpd`. Le passage échoue quand
  un envoi est dû et que Resend n'est pas configuré, ou quand des envois échouent ; le rattrapage de 14:30
  (le même jour, seulement si le passage de 12:30 a échoué) reprend les envois en échec. La file ne
  reprend un envoi que dans les 23 heures de son premier essai (la clé d'idempotence de Resend ne protège
  d'un doublon que 24 heures) : passé ce délai, la ligne reste en `failed` et est comptée dans
  `needsReview` du compte rendu du passage, à reprendre à la main. Le journal porte un type
  (`kind = 'trial_end'`) qui le distingue du préavis global de fin de l'offre (`launch_offer_end`) : les
  deux messages d'un même jour ne se bloquent pas. La désinscription reste commune aux deux.

- **Résumé quotidien « N réponses à relire »** (`REPLIES_REVIEW_DIGEST_MODE`, `/api/cron/replies-review-digest`,
  07:05, sans rattrapage) : un email d'exploitation aux adresses de `OPERATIONS_ALERT_EMAIL_TO` (trois au plus,
  même canal Resend que les incidents) qui compte les réponses de l'agent en relecture (traitement à l'état
  `review`, non marquées comme traitées) et les messages non rattachés à traiter (reçus à l'adresse de réponse
  sans dossier ouvert, table `information_agent_unrouted_messages`). Il liste au plus dix expéditeurs et objets
  par catégorie, jamais le corps d'un message, et renvoie vers `/admin/agent-ia`. Rien à relire, pas d'email.
  Valeurs : `off` (défaut, rien n'est lu ni envoyé), `preview` (les nombres sont lus et rendus dans le compte
  rendu du passage, aucun email), `on`. Ce n'est pas un message de l'agent d'information : il n'écrit jamais à
  l'expéditeur d'un message. Un seul email par jour de Paris (clé d'idempotence de Resend). Le passage échoue
  quand un résumé est dû et que le canal email n'est pas configuré, ou quand un envoi échoue. Non supervisé par
  `cron.stale` (journal d'exécution seulement), comme `trial-end-email`.

Les journaux des deux emails sont purgés à 180 jours par `run_data_retention` (cron hebdomadaire),
même quand l'envoi est fermé. Les deux tâches sont dans la liste attendue de `cron.stale`
(`app_private.evaluate_operational_health`) depuis la migration `20261110120200` : `sale-results` à 27 h,
`weekly-digest` à 8 jours (la route passe chaque jour et réussit même sans rien envoyer ; tant que les
interrupteurs sont à `off`, la supervision ne surveille que le déclenchement). Ordre de mise en production et
alerte transitoire à l'ouverture : « Ajouter une tâche supervisée » plus bas.

Les quatre tâches Vercel quotidiennes, et l'email de fin d'essai, ont un second passage deux heures plus
tard : il ne fait rien si la tâche a déjà réussi dans les 20 dernières heures (`catchUpSchedule` de `runMonitoredCron`).
Chaque passage réessaie 3 fois (5 s, 20 s, 60 s) sur une erreur réseau ou 5xx.

## Contrôle quotidien du registre des pièces (lot R2a, 11/11/2026)

`/api/cron/fact-registry-check` (Vercel Cron, 05:28 UTC) appelle `public.sync_fact_registry_alerts()`, sans
paramètre, qui lance le contrôle (lecture seule : la projection n'y est appelée qu'en simulation) page par page,
puis ouvre ou referme une alerte opérationnelle par contrôle. Le rapport ne porte que des comptes et des
identifiants de vente (20 au plus), jamais une valeur. Le résumé gardé dans `operational_job_runs` ne porte que
des comptes et des codes ; une erreur de la base n'y laisse que son étape et son code.

Depuis le lot R2b, la tâche fait d'abord un autre appel, dans sa propre transaction : la **relance planifiée de la
projection** (`public.reproject_fact_registry_drift()`, 30 ventes au plus par passe ; les passes s'enchaînent
tant que la base dit qu'il en reste et que 45 secondes ne sont pas écoulées, chacune dans sa transaction). Le
contrôle tourne ensuite dans tous les cas : si la relance a échoué, la tâche échoue à la fin et son message dit
les deux étapes. Pour une vente du registre
dont la simulation changerait la fiche, elle applique la projection. C'est une écriture de fiche lancée par cette
tâche ;
elle ne fait que réappliquer des décisions humaines déjà acceptées. Elle est **fermée par défaut** et ne s'ouvre
que par une décision du propriétaire (`docs/runbooks/registre-des-pieces-r2b.md`, « Relance planifiée de la
projection »).

| Alerte                                     | Ce qu'elle dit                                                                                                                                                                                                                                                                        | Gravité       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `fact_registry.projection_drift`           | La simulation de projection changerait une vente qui tient ou mémorise un champ, ou dont une pièce est acceptée (rejouée une fois avant d'être signalée)                                                                                                                              | critique      |
| `fact_registry.triggers_not_always`        | Un déclencheur du registre manque, n'est plus en mode `always` ou n'a plus la définition de sa migration, ou une table du registre n'a plus le propriétaire de la projection (remise en état du mode : `supabase/maintenance/20261117100600_restore_fact_registry_trigger_modes.sql`) | critique      |
| `fact_registry.column_mismatch`            | Une colonne tenue diffère de la valeur de son entrée, ou une surface tenue ne porte plus les libellés neutres                                                                                                                                                                         | critique      |
| `fact_registry.registry_label`             | `surface_source = 'fact_registry'` sur une vente dont aucune pièce ne tient la surface                                                                                                                                                                                                | critique      |
| `fact_registry.echo_suspected`             | La valeur d'une pièce, tenue, retirée ou opposée, est ailleurs que dans une colonne tenue : colonne voisine, copie (`properties`, `auction_surfaces`, `judicial_sales`) ou colonne d'un champ libéré                                                                                  | avertissement |
| `fact_registry.internal_column_copied`     | `raw_payload` d'une vente du registre contient la colonne interne                                                                                                                                                                                                                     | avertissement |
| `fact_registry.events_burst`               | Plus de 50 évènements d'écriture directe en 24 heures (annonce qui change, écho écarté) ; les évènements de la projection ne comptent pas                                                                                                                                             | avertissement |
| `fact_registry.echo_suppressed`            | La base a écarté le retour d'une ancienne valeur tenue dans les 48 heures : un chemin de la collecte a échappé à sa garde d'écho. Doit rester à zéro                                                                                                                                  | avertissement |
| `fact_registry.echo_blocked`               | Un champ libéré a retenu une écriture comme un écho il y a moins de 7 jours. Si l'alerte dure, l'annonce dit vraiment cette valeur et la fiche en affiche une ancienne : à relire                                                                                                     | avertissement |
| `fact_registry.stale_listing`              | L'annonce s'est tue sur un champ tenu (valeur d'annonce mémorisée peut-être périmée), ou une surface est encore tenue sur une vente devenue un terrain                                                                                                                                | avertissement |
| `fact_registry.reprojection_enabled`       | La relance planifiée de la projection est ouverte (lot R2b) : la tâche peut écrire des fiches. Reste ouverte tant que le propriétaire ne l'a pas refermée                                                                                                                             | avertissement |
| `fact_registry.final_decisions`            | Au moins une décision définitive (opposition, retrait pour autorisation retirée) sur 24 heures (lot R2b). Pour information : personne ne peut la défaire                                                                                                                              | avertissement |
| `fact_registry.final_decisions_over_limit` | Un auteur dépasse le plafond de cinq décisions définitives sur 24 heures, que la fonction de décision interdit : une écriture a contourné cette fonction                                                                                                                              | critique      |

- **Supervision.** La tâche est dans la liste attendue de `cron.stale` (27 heures, migration `20261117100600`).
  Mise en production sans manipuler de secret : fusionner, laisser Vercel déployer, attendre un passage planifié
  de la tâche (elle répond `skipped: migration_pending`, compté comme un succès), puis appliquer les migrations ;
  le passage du lendemain tombe avant 27 heures. Runbook `docs/runbooks/registre-des-pieces-r2a.md`.
- **Avant la migration.** Le code peut être déployé avant : la fonction est alors absente, la tâche réussit sans
  rien contrôler et le dit (`skipped: migration_pending` dans le journal des exécutions). **Après la migration,
  la réponse doit porter `counts`** : un `skipped` veut alors dire que PostgREST ne voit pas la fonction, et que
  rien n'est contrôlé. Cette tolérance sera retirée au lot R2b.
- **Borne.** 20 000 ventes du registre au plus par passage (40 pages de 500, depuis le lot R2b). Au-delà, le
  rapport est marqué tronqué : la base ne synchronise que les contrôles actifs (aucune alerte n'est refermée par
  un rapport partiel) et la tâche échoue.
- **Tant que rien n'est tenu** (lots R2a et R2b), les contrôles sont à zéro : seuls `triggers_not_always` et
  `registry_label` peuvent se lever, et `reprojection_enabled` si le propriétaire ouvre la relance.

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
ouverte jusqu'au premier passage de Vercel ; `sale-results` et `weekly-digest` (`20261110120200`) suivent la même
procédure : appeler `/api/cron/sale-results` puis `/api/cron/weekly-digest` avec `CRON_SECRET` juste après la
migration. Une redéfinition de la liste se fait par remplacement d'un fragment vérifié (`pg_get_functiondef`),
sans jamais retirer une entrée existante : la migration refuse de s'appliquer si une entrée manque avant ou après.
Procédure :

1. Déployer le code qui porte la route **avant** (ou en même temps que) la migration, jamais après.
2. Juste après la migration, appeler la route une fois avec `Authorization: Bearer $CRON_SECRET` : le succès
   enregistré referme la détection au passage suivant de `operational-health` (30 min).
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

Les positions des ventes à venir qui ont une adresse mais seulement le centre de leur commune (ou aucun point) sont
corrigées le 28/10/2026 de la même façon, sans planification nouvelle : après chaque passage de la file
d'enrichissement, le lanceur planifié exécute `src.address_positions` (au plus 500 ventes par passage, un envoi CSV au
géocodage en masse de la Géoplateforme par lot de 250 adresses, 6 minutes au plus). Le verrou des écritures du
catalogue n'est PAS tenu pendant les appels à la BAN : il est pris (2 minutes d'attente au plus) seulement pour écrire
chaque lot de 250 qui vient de répondre, une ligne par point de sauvegarde (une ligne en échec n'annule pas les
autres, `failed` dans le compte rendu). Le passage ne tourne pas quand la file d'enrichissement a échoué. Les règles d'acceptation sont celles de `geocode_sale` ; le passage n'écrit que les
coordonnées, les drapeaux de position et les clés `geo_precision`, `geocode` et `commune` de `raw_payload`. Son code
de sortie est noté dans `auction_runs.summary` (`address_positions_exit_code`) ; `ADDRESS_POSITIONS_ENABLED=false`
le suspend.

## Workflows GitHub Actions

| Workflow                                                                    | Déclencheur                                                                                                                                                                                             | Supervision                                                                                                                          |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Immojudis Data Pipeline (`data-pipeline.yml`)                               | aucun horaire GitHub : la base fixe les échéances (`claim_autonomous_pipeline_run`) et l'application déclenche le workflow à chaque passage d'`operational-health` (toutes les 30 min) ; + manuel       | alertes `pipeline.source.*`, `pipeline.import.unhealthy`                                                                             |
| Recompute des ventes existantes                                             | manuel                                                                                                                                                                                                  | verrou `immojudis-recompute` + verrou en base                                                                                        |
| DVF import                                                                  | **manuel** (`workflow_dispatch`, aucun planning)                                                                                                                                                        | alerte `dvf.freshness` (donnée de plus de 220 jours)                                                                                 |
| Information Agent Evidence (`information-agent-evidence.yml`)               | déclenché par `/api/cron/information-agent-inbound` (toutes les 2 min) dès qu'une analyse attend, au plus une fois par tranche de 10 min, sur `main` ; horaire GitHub de 30 min gardé en filet + manuel | analyse des pièces jointes privées de l'agent (OCR), lecture seule                                                                   |
| Sale flood risk (`sale-flood-risk.yml`)                                     | déclenché par `/api/cron/sale-flood-risk` + manuel                                                                                                                                                      | observation du risque d'inondation depuis GitHub Actions ; `cron.stale` (3 h) ; voir `docs/runbooks/georisques-pannes-inondation.md` |
| Production smoke (`production-smoke.yml`)                                   | planifié `*/30` (en pratique toutes les 2 à 6 h) + manuel                                                                                                                                               | échec du workflow ; voir `docs/operations/supervision-externe.md`                                                                    |
| Immojudis Operational Alert                                                 | déclenché par l'application                                                                                                                                                                             | échec = incident ouvert ; avertissement = rappel ; vert = résolution                                                                 |
| Entraînement du modèle de valorisation                                      | manuel                                                                                                                                                                                                  | rapport JSON + tableau de synthèse                                                                                                   |
| Apply Supabase Migrations                                                   | manuel depuis `main`                                                                                                                                                                                    | refuse si le CI du commit n'est pas vert ; contrôle de dérive                                                                        |
| Check Pending Supabase Migrations (`check-pending-supabase-migrations.yml`) | `push` sur `main` (migrations) + tous les jours 07:10 UTC                                                                                                                                               | échec = migrations de `main` non appliquées en production                                                                            |
| Pipeline tests, clock +60 days (`pipeline-clock-offset.yml`)                | lundi 05:17 UTC + manuel                                                                                                                                                                                | échec du workflow (informatif : détecte les dates écrites en dur dans les tests du pipeline, sans base ni secret)                    |
| CodeQL (`codeql.yml`)                                                       | pull requests, `push` sur `main` + lundi 03:25 UTC                                                                                                                                                      | alertes d'analyse de code de GitHub                                                                                                  |

### Analyse des réponses de l'agent : déclenchement à la réception (10/11/2026)

Les horaires GitHub n'étant pas tenus (4 à 11 heures entre deux passages observés pour
`information-agent-evidence.yml`), la passe des réponses (`/api/cron/information-agent-inbound`, toutes les
2 minutes) déclenche elle-même le workflow par `workflow_dispatch` (module
`src/lib/information-agent-evidence-dispatch.server.ts`) :

- seulement si une analyse est prenable par le worker (mêmes conditions que
  `claim_information_agent_evidence_extractions` : moins de 3 essais, échéance passée, en file ou en échec, ou en
  cours mais abandonnée depuis 45 minutes) ;
- au plus une fois par tranche de 10 minutes alignée sur l'horloge, tenue en base par le limiteur global
  (`consume_ip_rate_limit`, compteur `global.information-agent.evidence-dispatch`). Deux déclenchements de part et
  d'autre d'une limite de tranche peuvent être séparés de 2 minutes seulement ; le plafond reste de 6 par heure ;
- disjoncteur : au plus 24 déclenchements par jour (UTC, compteur
  `global.information-agent.evidence-dispatch.daily`). Le plafond de 3 essais d'une analyse n'augmente qu'à sa
  prise en charge par le worker : un workflow qui échoue avant (installation, secret) la laisserait prenable ;
- quand la plus ancienne analyse prenable attend depuis plus de 2 heures, plus aucun déclenchement : la passe
  rend le statut `stalled` (avec l'attente en minutes) dans son résumé, et seul l'horaire GitHub continue ;
- un jeton absent n'est tracé qu'une fois par tranche de 10 minutes (statut `token_missing`) ;
- toujours sur `main` (le workflow refuse toute autre branche), avec le jeton du pipeline (`GITHUB_SCROLL_TOKEN` ou
  ses équivalents), sans nouveau secret ;
- un échec (jeton absent, refus de GitHub, coupure, base indisponible) ne fait jamais échouer la passe : il est
  rendu dans le résumé de l'exécution (`evidenceDispatch`, ou dans le message d'erreur quand la passe échoue)
  et tracé avec son étape ou son statut HTTP seulement.
  L'horaire GitHub de 30 minutes reste le filet.

Délai visé entre la réception et l'analyse : quelques minutes (passe des réponses, puis démarrage du workflow).
