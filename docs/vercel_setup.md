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
| `STRIPE_SECRET_KEY`                  | ✅ prod  | Clé serveur Stripe utilisée pour le paiement unique Analyse à 29 €.                                                                                                 |
| `STRIPE_WEBHOOK_SECRET`              | ✅ prod  | Secret de signature du webhook qui attribue les 30 jours d'accès.                                                                                                   |
| `RESEND_API_KEY`                     | ✅ prod  | Clé serveur Resend pour envoyer les alertes email consenties et les emails aux avocats référencés.                                                                  |
| `ALERT_EMAIL_FROM`                   | ✅ prod  | Expéditeur vérifié Resend, par exemple `ImmoJudis <alertes@immojudis.fr>`.                                                                                          |
| `NEXT_PUBLIC_LEGAL_*`                | ✅ vente | Identité publique, contact, directeur de publication et médiateur ; le checkout reste bloqué et le build de production échoue si une valeur requise manque.         |
| `SITE_URL`                           | ✅ prod  | Origine canonique publique (`https://immojudis.com`). Replis : `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_APP_URL`, `APP_URL`. `VERCEL_URL` ne suffit plus en production. |
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

### Offre payante Stripe

Le checkout `/api/billing/checkout` crée un paiement unique de 29 € pour le plan
`analyse`. Le montant et la durée de 30 jours sont définis côté serveur ; aucun
Price ID récurrent n'est nécessaire. Le webhook vérifie la signature, traite
`checkout.session.completed` (et les paiements asynchrones réussis), puis inscrit
le Checkout Session dans un journal idempotent avant d'étendre l'accès de 30 jours.
Avant la création de la session, l’interface présente le récapitulatif, recueille les acceptations
contractuelles et la demande d’exécution immédiate. Une preuve versionnée et immuable est liée à la
session dans `commercial_acceptances`.
Il n'y a aucun renouvellement automatique.

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
