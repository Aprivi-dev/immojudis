# Inventaire des tâches planifiées

Mis à jour le 28 octobre 2026 (règle de répartition entre les trois planificateurs, filets quotidiens sans effet
quand `pg_cron` a réussi, inventaire des workflows GitHub planifiés). Toute route `src/app/api/cron/*` doit figurer
ici, dans `vercel.json` ou dans une migration `pg_cron`, et tout workflow GitHub qui a un `schedule` doit figurer
dans le tableau des workflows ; le test `src/lib/scheduled-jobs.test.ts` le vérifie.

## Qui déclenche quoi : la règle

Trois systèmes savent lancer une tâche. Chacun a un rôle, et une nouvelle tâche suit cette règle (à vérifier en
revue) :

| Système                     | Rôle                                                                                                                                                                                                                                       | Pourquoi                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Supabase `pg_cron`          | **Horloge** de tout ce qui tourne plusieurs fois par jour ou dépend d'un ordre précis (toutes les 2, 5 ou 15 min, chaque heure à une minute donnée). Il appelle une route `/api/cron/*` avec les secrets de Vault.                         | Seul planificateur gratuit précis à la minute et sans limite de fréquence.                                                |
| Vercel Cron (`vercel.json`) | Tâches **quotidiennes** (emails, purge) et **filets** quotidiens des tâches de `pg_cron`.                                                                                                                                                  | Le plan Hobby n'autorise qu'un passage par jour et par entrée, à n'importe quel moment de l'heure demandée.               |
| GitHub Actions              | Travail **long** (plus de 5 min : collecte, imports, entraînement) ou que la source refuse depuis Vercel (Géorisques). Lancé **sur demande** (`workflow_dispatch`) par l'application ou la base, jamais sur horaire pour une tâche métier. | Les horaires GitHub ne sont pas tenus : 44 passages au lieu d'environ 355 du 20 au 27/10/2026 (`supervision-externe.md`). |

Un **filet** est un second déclencheur de la même tâche par un autre chemin. Il ne fait rien quand le chemin
principal a réussi récemment (`catchUpSchedule` de `runMonitoredCron`, qui lit l'en-tête
`x-vercel-cron-schedule` envoyé par Vercel) : il ne sert que si ce chemin est en panne (secret Vault perdu, `pg_cron`
arrêté). Un appel de `pg_cron` n'a pas cet en-tête et s'exécute toujours.

Les workflows GitHub qui gardent un `schedule` sont des **contrôles** (test de fumée, migrations en attente,
CodeQL, horloge décalée du pipeline), à une exception près, l'analyse des pièces jointes de l'agent
d'information, qui tolère un retard de plusieurs heures. La liste est figée dans `scheduled-jobs.test.ts` : en
ajouter un demande de modifier ce test, donc une décision explicite.

La supervision de toute cette chaîne passe elle-même par `pg_cron` → Vercel → GitHub
(`operational-health`) : seule une sonde extérieure à ces trois services voit sa panne. Elle est à poser par le
propriétaire (`supervision-externe.md`, « Poser la sonde ») ; tant qu'elle n'existe pas, une panne de cette chaîne
reste silencieuse.

## Tâches applicatives (routes `/api/cron/*`)

| Tâche                                                      | Système            | Horaire (UTC)                                        | Route / script                        | Supervisée                                           | Seuil d'alerte (`cron.stale`) |
| ---------------------------------------------------------- | ------------------ | ---------------------------------------------------- | ------------------------------------- | ---------------------------------------------------- | ----------------------------- |
| Évaluation des alertes                                     | Vercel Cron        | 06:15, rattrapage 08:15                              | `/api/cron/smart-alerts`              | oui                                                  | pas de succès depuis 27 h     |
| Envoi des alertes                                          | Vercel Cron        | 07:30, rattrapage 09:30                              | `/api/cron/alert-notifications`       | oui                                                  | 27 h                          |
| Suivi des changements                                      | Vercel Cron        | 06:45, rattrapage 08:45                              | `/api/cron/sale-change-monitor`       | oui                                                  | 27 h                          |
| Rappels d'audience et avertissements graves                | Vercel Cron        | 07:15, rattrapage 09:15                              | `/api/cron/sale-reminders`            | oui                                                  | 27 h                          |
| Alertes de résultat ou de remise en vente                  | Vercel Cron        | 10:15                                                | `/api/cron/sale-results`              | journal d'exécution seulement                        | pas encore                    |
| Récapitulatif hebdomadaire « Ma semaine »                  | Vercel Cron        | 11:30                                                | `/api/cron/weekly-digest`             | journal d'exécution seulement                        | pas encore                    |
| Rétention des données                                      | Vercel Cron        | dimanche 04:15                                       | `/api/cron/data-retention`            | oui                                                  | 8 jours                       |
| Complétude des annonces (palier de classement de /sales)   | Supabase `pg_cron` | toutes les heures à :20                              | `/api/cron/listing-completeness`      | oui                                                  | 3 h                           |
| Complétude des annonces (filet quotidien)                  | Vercel Cron        | 05:50, sans effet si `pg_cron` a réussi dans les 2 h | `/api/cron/listing-completeness`      | oui (même tâche, même seuil)                         | 3 h                           |
| Risque d'inondation des ventes (règle `pepite-v2`)         | Supabase `pg_cron` | toutes les heures à :25                              | `/api/cron/sale-flood-risk`           | oui                                                  | 3 h                           |
| Risque d'inondation des ventes (filet quotidien)           | Vercel Cron        | 05:35, sans effet si la passe a réussi dans les 2 h  | `/api/cron/sale-flood-risk`           | oui (même tâche, même seuil)                         | 3 h                           |
| Pépites des ventes (règle `pepite-v1.1` ou `pepite-v2`)    | Supabase `pg_cron` | toutes les heures à :35                              | `/api/cron/sale-pepites`              | oui                                                  | 3 h                           |
| Pépites des ventes (filet quotidien)                       | Vercel Cron        | 05:42, sans effet si `pg_cron` a réussi dans les 2 h | `/api/cron/sale-pepites`              | oui (même tâche, même seuil)                         | 3 h                           |
| Santé opérationnelle                                       | Supabase `pg_cron` | toutes les 15 min                                    | `/api/cron/operational-health`        | oui                                                  | 45 min                        |
| Purge des ventes                                           | Supabase `pg_cron` | toutes les 5 min                                     | `/api/cron/sale-retention`            | oui                                                  | 20 min                        |
| Pré-calcul des valorisations                               | Supabase `pg_cron` | toutes les 5 min                                     | `/api/cron/precompute-valuations`     | non (déclenchement géré par la file de valorisation) | —                             |
| Réponses de l'agent (lecture seule, n'envoie aucun e-mail) | Supabase `pg_cron` | toutes les 2 min                                     | `/api/cron/information-agent-inbound` | oui                                                  | 10 min                        |

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
garder `('sale-pepites', interval '3 hours')` **et** `('sale-flood-risk', interval '3 hours')` dans sa liste de tâches
attendues (la seconde, ajoutée par la migration `20261106100300`, ne doit pas être perdue par une redéfinition ultérieure).

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
   Import » le recalcule à la fin de son étape d'import (`python -m src.dvf_market_trends`), sans nouvelle planification.
3. Déployer le code : la version appliquée devient `pepite-v1.2`, chaque pépite publiée est réévaluée en priorité au
   premier passage horaire et sort si elle ne remplit plus les critères (DPE F ou G, marché peu liquide ou en baisse,
   bien de plus de 250 m² ou de plus de 1 500 000 €, copropriété en difficulté). Renseigner alors
   `PEPITE_V1_2_EFFECTIVE_DATE` (`src/app/methode-pepites/method.ts`).

Sans agrégat (migration absente, commune sans vente), les critères de marché sont réussis : déployer avant l'étape 2
n'exclut rien. Un import DVF « replace_existing » remplace la table et supprime l'index : relancer
`npm run db:indexes:concurrent` ensuite.

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
  redéploiement) rétablit les appels depuis la route. Diagnostic des pannes (table des codes `network*_`,
`http\__`, `timeout`, `ppri_unreadable`, `write_busy_N`) : `docs/runbooks/georisques-pannes-inondation.md` ;
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

| Workflow                                                                    | Déclencheur                                                                                                                                                                            | Supervision                                                                                                                          |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Immojudis Data Pipeline (`data-pipeline.yml`)                               | aucun horaire GitHub : la base fixe les échéances (`claim_autonomous_pipeline_run`) et l'application déclenche le workflow à chaque passage d'`operational-health` (15 min) ; + manuel | alertes `pipeline.source.*`, `pipeline.import.unhealthy`                                                                             |
| Recompute des ventes existantes                                             | manuel                                                                                                                                                                                 | verrou `immojudis-recompute` + verrou en base                                                                                        |
| DVF import                                                                  | **manuel** (`workflow_dispatch`, aucun planning)                                                                                                                                       | alerte `dvf.freshness` (donnée de plus de 220 jours)                                                                                 |
| Information Agent Evidence (`information-agent-evidence.yml`)               | planifié toutes les 30 min + manuel (exception à la règle : tolère un retard de plusieurs heures)                                                                                      | analyse des pièces jointes privées de l'agent (OCR), lecture seule                                                                   |
| Sale flood risk (`sale-flood-risk.yml`)                                     | déclenché par `/api/cron/sale-flood-risk` + manuel                                                                                                                                     | observation du risque d'inondation depuis GitHub Actions ; `cron.stale` (3 h) ; voir `docs/runbooks/georisques-pannes-inondation.md` |
| Production smoke (`production-smoke.yml`)                                   | planifié `*/30` (en pratique toutes les 2 à 6 h) + manuel                                                                                                                              | échec du workflow ; voir `docs/operations/supervision-externe.md`                                                                    |
| Immojudis Operational Alert                                                 | déclenché par l'application                                                                                                                                                            | échec = incident ouvert ; avertissement = rappel ; vert = résolution                                                                 |
| Entraînement du modèle de valorisation                                      | manuel                                                                                                                                                                                 | rapport JSON + tableau de synthèse                                                                                                   |
| Apply Supabase Migrations                                                   | manuel depuis `main`                                                                                                                                                                   | refuse si le CI du commit n'est pas vert ; contrôle de dérive                                                                        |
| Check Pending Supabase Migrations (`check-pending-supabase-migrations.yml`) | `push` sur `main` (migrations) + tous les jours 07:10 UTC                                                                                                                              | échec = migrations de `main` non appliquées en production                                                                            |
| Pipeline tests, clock +60 days (`pipeline-clock-offset.yml`)                | lundi 05:17 UTC + manuel                                                                                                                                                               | échec du workflow (informatif : détecte les dates écrites en dur dans les tests du pipeline, sans base ni secret)                    |
| CodeQL (`codeql.yml`)                                                       | pull requests, `push` sur `main` + lundi 03:25 UTC                                                                                                                                     | alertes d'analyse de code de GitHub                                                                                                  |
