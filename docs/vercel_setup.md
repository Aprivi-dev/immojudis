# Immojudis — Déploiement

## Stack

- Next.js App Router (React 19)
- TypeScript strict
- Tailwind CSS v4 + shadcn/ui
- Supabase JS (auth, queries, RLS)
- Mapbox GL JS et Mapbox Static Images pour toutes les vues cartographiques

## 1. Installation locale

```bash
npm install
cp .env.example .env
# Renseigner les variables NEXT_PUBLIC_* ou VITE_* compatibles
npm run dev        # http://localhost:3000
```

## 2. Variables d'environnement

| Variable                             | Requis   | Description                                                                                                                                                         |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_SUPABASE_URL`                  | ✅       | URL du projet Supabase (`https://xxx.supabase.co`)                                                                                                                  |
| `VITE_SUPABASE_PUBLISHABLE_KEY`      | ✅       | Clé `anon` / `publishable` (publique, safe côté client)                                                                                                             |
| `SUPABASE_URL`                       | ✅ prod  | URL Supabase côté serveur. Repli possible sur `NEXT_PUBLIC_SUPABASE_URL`, mais il est préférable de la poser explicitement.                                         |
| `SUPABASE_SECRET_KEY`                | ✅ prod  | Clé serveur Supabase nouvelle génération, ou utiliser `SUPABASE_SERVICE_ROLE_KEY` pour les projets legacy.                                                          |
| `SUPABASE_SERVICE_ROLE_KEY`          | ✅ prod  | Clé serveur legacy Supabase, acceptée en repli de `SUPABASE_SECRET_KEY`.                                                                                            |
| `SUPABASE_DB_URL`                    | ✅ ops   | URL Postgres directe pour appliquer les migrations. Repli accepté : `POSTGRES_URL_NON_POOLING` ou `POSTGRES_URL`.                                                   |
| `GITHUB_SCROLL_TOKEN`                | ❌       | Token GitHub finement scopé pour déclencher immédiatement le workflow de scroll depuis `/admin`.                                                                    |
| `GITHUB_SCROLL_REPOSITORY`           | ❌       | Repo cible du workflow. Défaut : `Aprivi-dev/immojudis`.                                                                                                            |
| `GITHUB_SCROLL_WORKFLOW`             | ❌       | Workflow cible. Défaut : `data-pipeline.yml`.                                                                                                                       |
| `GITHUB_SCROLL_REF`                  | ❌       | Branche cible. Défaut : `main`.                                                                                                                                     |
| `CRON_SECRET`                        | ✅ prod  | Secret Vercel Cron envoyé en `Authorization: Bearer <secret>` pour `/api/cron/smart-alerts`.                                                                        |
| `OPERATIONS_ALERT_WEBHOOK_URL`       | ❌       | Webhook HTTPS externe prioritaire pour les incidents opérationnels.                                                                                                 |
| `OPERATIONS_ALERT_WEBHOOK_SECRET`    | ❌       | Bearer token associé au webhook opérationnel.                                                                                                                       |
| `OPERATIONS_ALERT_GITHUB_REPOSITORY` | ❌       | Repo du workflow d'alerte. Défaut : `Aprivi-dev/immojudis`.                                                                                                         |
| `SMART_ALERT_CRON_USER_LIMIT`        | ❌       | Nombre max d'utilisateurs Analyse évalués par exécution. Défaut : `25`.                                                                                             |
| `SMART_ALERT_CRON_SALE_LIMIT`        | ❌       | Nombre max de ventes actives/à venir évaluées par utilisateur. Défaut : `160`.                                                                                      |
| `ALERT_NOTIFICATION_CRON_LIMIT`      | ❌       | Nombre max de notifications d'alertes planifiées libérées par exécution. Défaut : `200`.                                                                            |
| `STRIPE_SECRET_KEY`                  | ✅ prod  | Clé serveur Stripe : abonnement récurrent Analyse de 59 € TTC / mois, essai de 7 jours. Price récurrent obligatoire (`STRIPE_ANALYSIS_PRICE_ID`).                   |
| `STRIPE_WEBHOOK_SECRET`              | ✅ prod  | Secret de signature du webhook Stripe qui met à jour l'accès Analyse.                                                                                               |
| `RESEND_API_KEY`                     | ✅ prod  | Clé serveur Resend pour envoyer les alertes email consenties et les emails aux avocats référencés.                                                                  |
| `ALERT_EMAIL_FROM`                   | ✅ prod  | Expéditeur vérifié Resend, par exemple `Immojudis <alertes@immojudis.com>`.                                                                                         |
| `NEXT_PUBLIC_LEGAL_*`                | ✅ vente | Identité publique, contact, directeur de publication et médiateur ; le checkout reste bloqué et le build de production échoue si une valeur requise manque.         |
| `SITE_URL`                           | ✅ prod  | Origine canonique publique (`https://immojudis.com`). Replis : `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_APP_URL`, `APP_URL`. `VERCEL_URL` ne suffit plus en production. |
| `SEO_INDEXING_ENABLED`               | ❌       | Interrupteur d'indexation, **fermé par défaut** : seule la valeur `true` ouvre le site aux moteurs de recherche (voir « Indexation et référencement »).             |
| `ADMIN_MFA_REQUIRED`                 | ✅ prod  | Doit valoir `true` : second facteur obligatoire pour l'administration.                                                                                              |
| `ALLOW_INCOMPLETE_LAUNCH_CONFIG`     | ❌       | Échappatoire temporaire du build de production (voir ci-dessous).                                                                                                   |

Avant un déploiement production complet, vérifier les variables serveur :

```bash
npm run env:check:prod
```

Les variables sensibles Vercel peuvent être présentes mais illisibles après
`vercel env pull`. Dans ce cas, le check valide leur déclaration côté Vercel, mais
les migrations locales nécessitent toujours une valeur Postgres lisible
(`SUPABASE_DB_URL`, `POSTGRES_URL_NON_POOLING` ou `POSTGRES_URL`).

⚠️ **Ne JAMAIS** ajouter `SUPABASE_SECRET_KEY` ou `SUPABASE_SERVICE_ROLE_KEY` au front. Ces clés bypassent RLS.

### Runner de scroll admin

La page `/admin` crée une ligne `auction_runs` en statut `queued`.

Le pipeline ne peut ensuite démarrer que par **déclenchement manuel** : si
`GITHUB_SCROLL_TOKEN` est configuré dans Vercel, une action explicite dans
`/admin` déclenche le workflow GitHub Actions `data-pipeline.yml` avec
l'identifiant du run. Il n'existe aucun fallback planifié. Si le dispatch
échoue, la ligne reste `queued` jusqu'à une nouvelle action manuelle.

Secrets à configurer dans GitHub Actions pour que le worker puisse écrire dans Supabase :

| Secret GitHub Actions       | Requis | Description                                                                                                                    |
| --------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `SUPABASE_URL`              | ✅     | URL Supabase projet `immojudis`.                                                                                               |
| `SUPABASE_SECRET_KEY`       | ✅     | Clé serveur Supabase nouvelle génération, utilisée uniquement par le worker CI.                                                |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅     | Clé serveur legacy si `SUPABASE_SECRET_KEY` n'est pas encore utilisée.                                                         |
| `SUPABASE_DB_URL`           | ✅     | URL Postgres utilisée par le workflow de migrations. Replis acceptés côté script : `POSTGRES_URL_NON_POOLING`, `POSTGRES_URL`. |
| `REPLICATE_API_TOKEN`       | ❌     | Token LLM pour l'enrichissement premium, si disponible.                                                                        |
| `CRON_SECRET`               | ✅ ops | Même secret que Vercel, utilisé pour provisionner le callback Supabase Cron sans l'inscrire dans les migrations.               |

Le token `GITHUB_SCROLL_TOKEN` côté Vercel doit être un fine-grained PAT GitHub limité au repo `Aprivi-dev/immojudis` avec accès Actions en écriture.
Il sert aussi de canal externe par défaut pour `operational-alert.yml`; un webhook HTTPS dédié peut
le remplacer avec `OPERATIONS_ALERT_WEBHOOK_URL`.
Pour recevoir aussi chaque incident par email, poser `OPERATIONS_ALERT_EMAIL_TO` (adresse du propriétaire ;
`RESEND_API_KEY` et `ALERT_EMAIL_FROM` doivent être présents) : sans cette variable, aucun email d'incident
n'est envoyé.

### Offre payante Stripe

Le checkout `/api/billing/checkout` crée un abonnement récurrent de 59 € TTC / mois pour le plan
`analyse`, avec un essai de 7 jours (`ANALYSIS_TRIAL_DAYS`, `src/lib/analysis-offer.ts`). Un **Price Stripe
récurrent est obligatoire** (`STRIPE_ANALYSIS_PRICE_ID`) : la route le valide côté serveur et refuse tout autre
Price ; sans lui, la souscription reste fermée (« Tarif prévu, pas encore souscriptible »). Le webhook vérifie
la signature, traite les événements du Checkout et de l'abonnement (création, mise à jour, résiliation,
échec de paiement, remboursement), puis inscrit chaque événement dans un journal idempotent avant de modifier
l'accès. Avant la création de la session, l’interface présente le récapitulatif, recueille les acceptations
contractuelles et la demande d’exécution immédiate. Une preuve versionnée et immuable est liée à la
session dans `commercial_acceptances`. L'abonnement se renouvelle chaque mois jusqu'à sa résiliation.

### Accès API léger

Les abonnés avec `sales.apiAccess` peuvent créer des clés API depuis la page
`/accompagnement`. Les clés complètes ne sont affichées qu'une seule fois ;
Supabase ne stocke que le hash SHA-256 et le préfixe de lookup.

Le feed ventes accepte ensuite :

```bash
curl "$NEXT_PUBLIC_APP_URL/api/sales/feed?limit=50" \
  -H "X-ImmoJudis-Api-Key: ij_live_..."
```

Le même endpoint continue aussi d'accepter le Bearer token Supabase utilisé par
le front connecté.

### Cron alertes intelligentes

`vercel.json` planifie `/api/cron/smart-alerts` tous les jours à `06:15 UTC`.
Sur Vercel Hobby, les crons doivent rester quotidiens : `/api/cron/alert-notifications`
est planifié à `06:30 UTC` et `/api/cron/sale-change-monitor` à `06:45 UTC`.
Sur un plan Vercel Pro, ces deux derniers crons peuvent repasser à `*/15 * * * *`
pour se rapprocher du temps réel. Les routes refusent toute requête sans
`Authorization: Bearer $CRON_SECRET`.

### Contrôle de santé opérationnelle

Le plan Vercel Hobby ne permettant qu'une exécution quotidienne, le contrôle de santé est lancé
toutes les 15 minutes par Supabase Cron. Le même planificateur traite les réponses de l'agent
toutes les deux minutes par un job distinct. Ces jobs appellent des routes protégées avec l'URL
et le Bearer token chiffrés dans Supabase Vault par :

```bash
npm run ops:health-scheduler:configure
```

Le calcul du palier de complétude des annonces (classement de `/sales`, route
`/api/cron/listing-completeness`) suit le même mécanisme : le job Supabase Cron
`immojudis-listing-completeness` l'appelle toutes les heures (à :20) avec les mêmes secrets Vault,
sans nouvelle configuration. `vercel.json` ne garde qu'un filet quotidien (05:50 UTC, décalé du job horaire pour ne pas se chevaucher), compatible
avec Vercel Hobby. La tâche figure dans la liste de fraîcheur `cron.stale` (3 h).

L'observation du risque d'inondation des ventes (`/api/cron/sale-flood-risk`, règle `pepite-v2`) suit le même
mécanisme : le job `immojudis-sale-flood-risk` l'appelle toutes les heures (à :25, avant le calcul des pépites) avec
les mêmes secrets Vault ; `vercel.json` garde un filet quotidien (05:35 UTC). La tâche figure dans la liste de
fraîcheur `cron.stale` (3 h). La règle `pepite-v2` n'est appliquée que si la variable `PEPITE_RULE_V2_ENABLED` vaut
`true` (fermée par défaut) : voir `operations/planification.md`.

Le calcul des pépites (`/api/cron/sale-pepites`) suit le même mécanisme : le job `immojudis-sale-pepites`
l'appelle toutes les heures (à :35) avec les mêmes secrets Vault ; `vercel.json` garde un filet quotidien
(05:42 UTC). La tâche figure dans la liste de fraîcheur `cron.stale` (3 h). Mode `shadow` à l'application de la
migration, `on` depuis le 26/10/2026 (migration `20261105100000`).

Le workflow `Apply Supabase Migrations` exécute automatiquement cette étape, puis vérifie l'absence
de dérive du schéma distant. Voir [`operations-phase-3.md`](operations-phase-3.md) pour les SLO,
tableaux de bord et runbooks.

### Workflow `Apply Supabase Migrations` : ordre de publication et diagnostic

**Ordre de publication.** Le code déployé par Vercel suppose que les migrations de la même PR sont
en production. Dès qu'une PR contenant un fichier `supabase/migrations/*.sql` est fusionnée dans
`main`, lancer sans attendre le workflow `Apply Supabase Migrations` (Actions, depuis `main`,
`confirm_target` = `production`). Ne pas attendre le prochain lot : le 14/10/2026, quatre
migrations (`20261021120000` à `20261023110000`) sont restées en retard sur `main` alors que le code
correspondant était en ligne, et la fonction de déblocages de l'offre Découverte était cassée en
production.

**Garde-fous du workflow.** Le lancement reste manuel (aucune application automatique). Avant
d'appliquer quoi que ce soit, le travail `validate` lit les contrôles du commit par l'API GitHub
(`GITHUB_TOKEN`, droit `checks: read` seul, `scripts/check-commit-ci-green.mjs`) et refuse tant que
l'un des travaux de `ci.yml` n'est pas terminé et vert : attendre la fin du CI (ou le relancer), puis
relancer le workflow. Les secrets de base ne sont donnés qu'aux étapes qui parlent à la base.
Le contrôle `Check Pending Supabase Migrations` démarre aussi à chaque `push` sur `main` qui touche
`supabase/migrations/**` : il est alors rouge jusqu'à l'application des migrations, ce qui prévient
dès la fusion et non quatre à sept heures plus tard.

**Un échec de l'étape « Detect production schema drift » ne dit pas la même chose selon le message
du journal** (les migrations, elles, sont déjà appliquées quand cette étape s'exécute) :

| Message du journal                                       | Signification                                                                                                                            | Que faire                                                                                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `[schema-drift] REAL DRIFT: Production differs from ...` | Dérive réelle : le schéma de production diffère des migrations. Le diff est affiché. Jamais réessayée automatiquement.                   | Enquêter et corriger (migration de réconciliation ou entrée justifiée dans `scripts/lib/schema-drift.mjs`). Relancer ne servirait à rien. |
| `[schema-drift] TOOL UNREACHABLE: ... after 3 attempts`  | Outil injoignable : l'outil de diff (Supabase CLI) n'a pas pu se connecter à la base (timeout, `ECONNRESET`, ...). Aucun schéma comparé. | Ce n'est pas une dérive. Relancer le workflow (les migrations déjà appliquées sont ignorées) ou `npm run check:schema-drift -- --remote`. |
| `[schema-drift] DIFF TOOL FAILED: ... not retried`       | L'outil de diff a échoué pour une autre raison (erreur SQL, authentification, ...). Le schéma n'a pas été comparé.                       | Lire l'erreur affichée au-dessus du message ; ne pas conclure à une dérive.                                                               |

Sur une erreur de connexion transitoire (`timeout exceeded when trying to connect`,
`PGDELTA_SCRIPT_ERROR` lié à la connexion, `ECONNRESET`, `ETIMEDOUT`, etc.), le contrôle réessaie
deux fois, après 20 s puis 40 s (3 tentatives en tout), avant de conclure à « outil injoignable ».
Un diff terminé n'est jamais réessayé : une vraie dérive échoue du premier coup. Cas observé : le run
#80 (14/10/2026), migrations appliquées mais étape de dérive en échec sur un timeout de connexion de
pg-delta, run #81 entièrement vert.

### Contrôle quotidien des migrations en attente

Le workflow `Check Pending Supabase Migrations`
(`.github/workflows/check-pending-supabase-migrations.yml`) s'exécute tous les jours à 07:10 UTC
(et à la main via `workflow_dispatch`, uniquement depuis `main`). Il compare les fichiers
`supabase/migrations/*.sql` de `main` avec `supabase_migrations.schema_migrations` en production, avec
les mêmes secrets que le workflow de migration (environnement `Production` : `SUPABASE_DB_URL`,
`SUPABASE_DB_SSL_CA`, SSL `verify-full`).

- **Lecture seule** : il exécute `node scripts/apply-supabase-migrations.mjs --dry-run
--fail-on-pending`, dont le seul accès à la base est un `SELECT` sur l'historique. Il n'applique
  aucune migration et n'écrit rien.
- **Vert** : l'historique de production est à jour.
- **Rouge** : le journal et l'annotation `Pending Supabase migrations` listent les fichiers en attente.
  GitHub envoie alors un e-mail de workflow en échec. Lancer `Apply Supabase Migrations`. Un échec peut
  aussi signaler un historique incohérent (« Migration history integrity checks failed ») ou une base
  injoignable après les reprises du script : le message du journal le précise.
- Il ne collecte aucune donnée : il n'appartient pas à la liste des workflows de collecte de
  `scripts/check-manual-data-collection.mjs`, qui reste inchangée.

Le cron `/api/cron/smart-alerts` évalue les alertes avancées des utilisateurs ayant un accès
Analyse actif, persiste les lignes dans `user_alert_matches`, puis met à jour
`last_evaluated_at` et `last_match_count` sur chaque alerte.

Le cron `/api/cron/alert-notifications` transforme les digests `queued` échus en
notifications `sent`, afin qu'ils apparaissent dans l'inbox utilisateur sans
dupliquer les envois si plusieurs exécutions se croisent.
Si `RESEND_API_KEY`, `ALERT_EMAIL_FROM` et `NEXT_PUBLIC_APP_URL` sont configurés,
ce même cron expédie aussi les notifications `email` consenties. Chaque email
inclut un lien de désinscription qui révoque le consentement dans
`user_notification_preferences`.

Ces mêmes variables servent aux emails de mise en relation avocat : quand un
admin assigne une demande à un avocat référencé et la passe en statut
`sent_to_lawyer`, ImmoJudis envoie un email au cabinet référencé si sa fiche
contient une adresse email. Les contacts avocat issus des annonces sources ne
sont jamais utilisés pour cet envoi.

## 3. Setup Supabase

Dans le SQL editor de ton projet Supabase, exécuter :

```
sql/vercel_app_setup.sql
```

Ce script :

- crée `public.v_auction_sales_app_preview` pour l'aperçu public limité ;
- crée `public.v_auction_sales_app` pour les détails réservés aux comptes connectés ;
- crée les tables `public.user_favorites` et `public.user_alerts` ;
- active RLS + policies (chaque user ne voit que ses favoris/alertes) ;
- limite la lecture anonyme à `id` + `starting_price_eur` sur les annonces éligibles ;
- crée les index nécessaires.

### Configuration Auth (Supabase Dashboard → Authentication → URL configuration)

- **Site URL** : URL prod Vercel (ex: `https://enchères-immo.vercel.app`)
- **Redirect URLs** :
  - `http://localhost:3000/**`
  - `https://<your-domain>.vercel.app/**`
  - (et le cas échéant le domaine custom)

Pour la V1 : auth par **email + mot de passe**. La confirmation par email
peut être désactivée dans Auth → Providers → Email pour accélérer les tests.

### Garde-fous du build de production

Quand `VERCEL_ENV=production`, `npm run build` (script `scripts/verify-required-env.mjs`)
échoue si l'un de ces points manque :

- une variable `NEXT_PUBLIC_LEGAL_*` requise (sinon le site afficherait « À renseigner avant
  commercialisation ») ;
- `ADMIN_MFA_REQUIRED=true` ;
- une origine canonique explicite (`SITE_URL`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_APP_URL` ou
  `APP_URL`) : `VERCEL_URL` change à chaque déploiement et ne compte pas.

**Échappatoire.** Tant que les valeurs ne sont pas fournies, `ALLOW_INCOMPLETE_LAUNCH_CONFIG=true`
(variable Vercel, environnement Production) transforme les erreurs sur les mentions légales et
`ADMIN_MFA_REQUIRED` en avertissements encadrés de `!!!` dans le journal de build. Le déploiement
passe, mais il n'est **pas conforme** : mentions légales absentes ou administration sans second
facteur. Retirer la variable dès que les valeurs sont renseignées, puis redéployer. Seule la
valeur exacte `true` est prise en compte. L'origine canonique n'est jamais contournable : sans
elle, les adresses canoniques, `robots.txt` et le sitemap de production pointeraient vers
`localhost`.

`npm run env:check:prod` n'accepte plus `VERCEL_URL` comme origine canonique.

### Indexation et référencement

#### Interrupteur `SEO_INDEXING_ENABLED`

Le site est **fermé aux moteurs de recherche par défaut**. Il ne s'ouvre que si la variable
`SEO_INDEXING_ENABLED` vaut exactement `true` (espaces autour ignorés ; `TRUE`, `1`, `yes`,
vide ou absente ferment).

| État                                    | `X-Robots-Tag`                             | `robots.txt`                                                   |
| --------------------------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| Fermé (variable absente ou ≠ `true`)    | `noindex, nofollow` (pages, API, sitemaps) | `Allow: /` + zones privées en `Disallow`, **aucun** `Sitemap:` |
| Ouvert (`true`, déploiement production) | aucun                                      | idem + les `Sitemap:` (pages, ressources, fiches)              |
| Aperçu ou développement Vercel          | `noindex, nofollow` (pages, API, sitemaps) | `Disallow: /`, aucun `Sitemap:` (même avec `true`)             |

- **Pourquoi `noindex` en en-tête plutôt que `Disallow: /`.** Un robot qui n'a pas le droit de
  charger une page ne lit jamais son `noindex` : une adresse déjà connue (lien externe, passage
  antérieur) peut rester listée sans extrait. Garder `Allow: /` laisse le robot lire l'en-tête et
  retirer l'adresse. L'aperçu Vercel garde `Disallow: /` (aucune adresse n'y est à retirer).
- **Lecture à l'exécution.** L'en-tête est posé par `src/proxy.ts` et `robots.txt` est généré à
  chaque requête : ni l'un ni l'autre n'est figé dans le build. (L'ancien en-tête de
  `next.config.ts`, calculé au build, aurait suivi un build promu d'un environnement à l'autre.)
  La variable reste celle du **déploiement** : Vercel n'applique un changement de variable qu'à un
  nouveau déploiement (Redeploy), et un déploiement restauré (rollback, promotion) garde les
  variables avec lesquelles il a été créé.
- **Absente en production = fermé.** Un déploiement de production sans `SEO_INDEXING_ENABLED`
  envoie `noindex, nofollow` et un `robots.txt` sans sitemap. Rien ne s'indexe par oubli.
- **Limite.** Le proxy ne passe pas sur les fichiers statiques (`/_next/static`, `/media/`,
  `/brand/`, icônes), sur `robots.txt` ni sur l'optimiseur d'images `/_next/image` : ces réponses
  n'ont **pas** l'en-tête, donc « partout » du tableau ci-dessus s'entend « sur les pages, les
  routes d'API et les sitemaps » (`/sitemap.xml`, `/ressources/sitemap.xml`,
  `/sales/sitemap/N.xml`). `/_next/image` est exclu volontairement : Next.js recommande de ne pas
  y exécuter le proxy, qui tournerait à chaque variante d'image uniquement pour poser cet en-tête.
  Conséquence : tant que l'indexation est fermée, une image de fiche reste techniquement
  indexable par un moteur d'images, même si la page qui l'affiche est en `noindex`. Si cet écart
  devient gênant, il faudra poser l'en-tête sur ces chemins par `headers()` dans `next.config.ts`
  (valeur figée au build, donc à réserver à un déploiement dont l'état d'indexation est connu).
- **Test de fumée.** `scripts/check-production-smoke.mjs` lit la même variable
  `SEO_INDEXING_ENABLED` pour savoir quel état vérifier. La variable de **dépôt GitHub** du même
  nom (Settings → Secrets and variables → Actions → Variables) doit donc suivre celle de Vercel.
  Depuis l'ouverture du 15/10/2026, le workflow « Production smoke » attend un site **ouvert**
  quand cette variable est absente : pour refermer l'indexation, poser `false` côté GitHub en même
  temps que Vercel.
- **Test de fumée du catalogue.** Quel que soit l'état de l'indexation, le script vérifie aussi :
  deux requêtes successives sur `/sales` (la seconde en `x-vercel-cache: HIT`, sans `Set-Cookie` ni
  `Vary`, des liens `/sales/<uuid>` dans le HTML), `/sales/defaut` en `noindex`, au moins 20 liens de
  fiches dans le HTML de `/sales?page=2`, un `cache-control` public sur `/api/catalogue/preview`, et
  (indexation ouverte) aucun sitemap qui liste `/sales/defaut`. Une alerte ici veut dire que le cache de
  `/sales` ne sert plus (cookie, `Vary`, rendu dynamique) ou que la page paginée a perdu ses annonces.
  Voir `docs/runbooks/catalogue-visibility-projection.md`.

#### Les trois sitemaps

`robots.txt` (quand l'indexation est ouverte) liste tous les sitemaps. Next.js ne génère pas
d'index de sitemaps : ce sont des fichiers séparés, soumis chacun à Search Console.

| Fichier                         | Contenu                                                              | Source                          |
| ------------------------------- | -------------------------------------------------------------------- | ------------------------------- |
| `/sitemap.xml`                  | Pages (accueil, catalogue, offres, guide, tribunaux, pages légales…) | `src/app/sitemap.ts`            |
| `/ressources/sitemap.xml`       | Articles du blog, `lastmod` = `updatedAt`, sinon `publishedAt`       | `src/app/ressources/sitemap.ts` |
| `/sales/sitemap/0.xml`, `1.xml` | Fiches de ventes publiques **et indexables**, 5 000 URL par fichier  | `src/app/sales/sitemap.ts`      |

- **Fiches minces exclues.** La fonction SQL `app_private.is_indexable_public_sale` (migration
  `20261025120000_indexable_public_sale_predicate.sql`) écarte du sitemap les fiches sans ville,
  sans date exploitable, sans type précis (sauf fiche documentée) ou sans surface ni mise à prix.
  La même fonction décide du `noindex, follow` de la page via `get_public_sale_indexability`.
  **Appliquer cette migration avant l'ouverture** : sans elle, le sitemap liste toutes les ventes
  visibles et la page retombe sur la copie TypeScript du prédicat (`isIndexablePublicSale`).
- **`lastmod` des fiches.** C'est `auction_sales.updated_at`, que le pipeline réécrit à **chaque
  passage** (`src/storage/supabase_client.py`, `row["updated_at"] = now`), même quand la vente n'a
  pas changé : la date reflète le dernier passage, pas un changement de contenu. Google ignore un
  `lastmod` qu'il juge inexact. Piste : une colonne `content_changed_at`, mise à jour par le
  pipeline seulement quand la mise à prix, la date, le statut, les photos ou les pièces changent,
  puis lue par `list_public_sale_sitemap_entries`. Non faite (elle touche l'écriture du pipeline
  et la table `auction_sales` et ses triggers). À défaut, retirer `lastModified` de
  `src/app/sales/sitemap.ts` est préférable à une date trompeuse.

#### Jour d'ouverture

À faire dans cet ordre, une fois la décision d'ouvrir prise (société créée, mentions légales
renseignées, données relues).

1. **Migrations.** `20261025120000_indexable_public_sale_predicate.sql` est appliquée en
   production (par le propriétaire, jamais par un agent).
2. **Redirections de domaine.** Vérifier que les variantes renvoient en **301** (ou 308,
   permanent) vers l'origine canonique, sans chaîne : `www.immojudis.com`, `immojudis.fr`,
   `www.immojudis.fr`. Depuis un poste :
   `curl -sI https://www.immojudis.com/sales | grep -iE "^(HTTP|location)"` (idem pour les autres) ;
   `location` doit être `https://immojudis.com/sales`. Réglage : Vercel → Project → Domains →
   la variante → « Redirect to » le domaine canonique, code permanent.
3. **Origine canonique.** `SITE_URL=https://immojudis.com` (Production). Contrôle :
   `npm run env:check:prod`.
4. **Ouvrir l'indexation.**
   - Vercel → Environment Variables → `SEO_INDEXING_ENABLED=true`, environnement **Production**
     uniquement, puis Redeploy.
   - GitHub → Settings → Secrets and variables → Actions → Variables → `SEO_INDEXING_ENABLED=true`
     (facultatif depuis le 15/10/2026 : sans variable, le test de fumée attend déjà un site ouvert).
   - Lancer à la main le workflow « Production smoke » (Actions → Run workflow) : il doit passer
     avec l'état « ouvert ».
   - À la main : `curl -s https://immojudis.com/robots.txt` doit contenir les trois sortes de
     `Sitemap:` et aucun `Disallow: /` ; `curl -sI https://immojudis.com/ | grep -i x-robots-tag`
     ne doit rien afficher.
5. **Google Search Console.** Créer une propriété **Domaine** `immojudis.com` (vérification par un
   enregistrement DNS TXT chez le gestionnaire du domaine : elle couvre `www`, `http` et tous les
   sous-domaines). Puis Sitemaps → ajouter `sitemap.xml`, `ressources/sitemap.xml` et chaque
   `sales/sitemap/N.xml` (le nombre de fichiers est celui de `robots.txt`). Inspecter ensuite
   l'accueil, une fiche et un article (« Tester l'URL en direct », puis « Demander une indexation »
   pour l'accueil).
6. **Bing Webmaster Tools.** Importer la propriété depuis Search Console (ou la vérifier par DNS),
   puis soumettre les mêmes sitemaps. Bing alimente aussi plusieurs moteurs tiers.
7. **Suivi.** Rapport « Pages » de Search Console : « Exclue par la balise noindex » doit
   correspondre aux fiches minces et à `/login` ; surveiller « Explorée, actuellement non
   indexée » sur les fiches. Reprendre le décompte des fiches listées dans les sitemaps (somme
   des URL de `sales/sitemap/N.xml`) après chaque évolution du prédicat.

**Retour arrière.** Poser `SEO_INDEXING_ENABLED=false` (ou supprimer la variable), Redeploy : le
`noindex` repart sur toutes les réponses et `robots.txt` retire les sitemaps. Pour retirer vite
des adresses déjà indexées : Search Console → Suppressions, en plus du `noindex`.

### Pages publiques de prix d'adjudication

Drapeaux d'environnement **fermés par défaut**, lus à chaque rendu, qui ne s'ouvrent que si la
valeur est exactement la chaîne `true` (pas d'espaces, `TRUE`, `1` ou `yes`).

| Drapeau                                 | Défaut | Effet quand il vaut `true`                                                                                                                                                                                                                           |
| --------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_ADJUDICATION_PRICES_ENABLED`    | éteint | Ouvre `/prix-encheres-immobilieres` (prix final médian rapporté à la mise à prix, part adjugée au-dessus de la mise, ventilation par type de bien, méthode). Éteint : réponse 404, `noindex`, absente de `sitemap.xml`. Aucun lien du site n'y mène. |
| `ADJUDICATION_PRICE_STATISTICS_ENABLED` | éteint | Existant ; **doit aussi valoir `true`** : c'est l'interrupteur d'arrêt des statistiques de prix. Le couper ferme cette page publique en même temps que les statistiques réservées à l'offre Analyse.                                                 |

La page ne sert que des agrégats nationaux déjà publiés par
`published_adjudication_price_statistics` (jamais une vente, une adresse, un nom ni le détail d'un
tribunal) et masque toute cellule de moins de 10 prix. Aucune migration n'est nécessaire.

**Conditions pour allumer `PUBLIC_ADJUDICATION_PRICES_ENABLED`, toutes deux requises** :

1. l'**accord écrit de Licitor** (source des prix d'adjudication) est obtenu : l'accord téléphonique
   décrit dans `docs/model-card-tribunal-statistics.md` ne suffit pas pour une publication en
   accès libre ;
2. la **relecture juridique-rgpd** (droit des bases de données, RGPD) est faite.

Ensuite : poser la variable en **Production**, Redeploy, vérifier que la page répond 200 et
apparaît dans `sitemap.xml`. L'indexation par les moteurs dépend en plus de
`SEO_INDEXING_ENABLED` (voir plus haut). **Retour arrière** : supprimer la variable (ou la passer à
`false`) et redéployer ; la page redevient 404.

Pages de « résultat » des ventes passées (`PUBLIC_PAST_SALE_PAGES_ENABLED`,
`PUBLIC_PAST_SALE_PAGES_INDEXABLE`) : **pas implémentées**. Les données publiables n'existent plus
après la purge du catalogue (analyse du 15/10/2026) ; ces drapeaux n'existent donc pas encore.

## 4. Build

```bash
npm run build      # build production
npm run preview    # smoke test du build
```

## 5. Déploiement Vercel

Le projet cible Vercel. Pour déployer :

1. Importer le repo dans Vercel.
2. Framework preset : **Next.js**.
3. Build command : `npm run build`.
4. Output directory : laisser la valeur auto générée par Next.js/Vercel.
5. Renseigner les variables Supabase publiques et `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` dans Project Settings → Environment Variables.
6. Donner le rôle admin via Supabase Auth `app_metadata.role = admin`.
7. Deploy.

> Note : le projet est configuré en Next.js App Router. Les anciennes variables
> `VITE_*` restent lues par compatibilité, puis exposées côté Next via les
> équivalents `NEXT_PUBLIC_*` quand nécessaire.

## 6. Tests d'acceptation

- `/` affiche les stats (depuis Supabase)
- `/sales` liste les annonces, filtres modifient l'URL
- `/sales/:id` affiche le détail + documents
- Les données utilisateur restent isolées par compte via RLS.
