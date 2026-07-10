# Immojudis — Déploiement

## Stack

- Next.js App Router (React 19)
- TypeScript strict
- Tailwind CSS v4 + shadcn/ui
- Supabase JS (auth, queries, RLS)
- OpenStreetMap sur les pages détail et listes

## 1. Installation locale

```bash
npm install
cp .env.example .env
# Renseigner les variables NEXT_PUBLIC_* ou VITE_* compatibles
npm run dev        # http://localhost:3000
```

## 2. Variables d'environnement

| Variable                        | Requis  | Description                                                                                                                 |
| ------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `VITE_SUPABASE_URL`             | ✅      | URL du projet Supabase (`https://xxx.supabase.co`)                                                                          |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | ✅      | Clé `anon` / `publishable` (publique, safe côté client)                                                                     |
| `SUPABASE_URL`                  | ✅ prod | URL Supabase côté serveur. Repli possible sur `NEXT_PUBLIC_SUPABASE_URL`, mais il est préférable de la poser explicitement. |
| `SUPABASE_SECRET_KEY`           | ✅ prod | Clé serveur Supabase nouvelle génération, ou utiliser `SUPABASE_SERVICE_ROLE_KEY` pour les projets legacy.                  |
| `SUPABASE_SERVICE_ROLE_KEY`     | ✅ prod | Clé serveur legacy Supabase, acceptée en repli de `SUPABASE_SECRET_KEY`.                                                    |
| `SUPABASE_DB_URL`               | ✅ ops  | URL Postgres directe pour appliquer les migrations. Repli accepté : `POSTGRES_URL_NON_POOLING` ou `POSTGRES_URL`.           |
| `NEXT_PUBLIC_OSM_TILE_URL`      | ❌      | Template de tuiles OSM compatible `{z}/{x}/{y}`. Défaut : `https://tile.openstreetmap.org/{z}/{x}/{y}.png`.                 |
| `GITHUB_SCROLL_TOKEN`           | ❌      | Token GitHub finement scopé pour déclencher immédiatement le workflow de scroll depuis `/admin`.                            |
| `GITHUB_SCROLL_REPOSITORY`      | ❌      | Repo cible du workflow. Défaut : `Aprivi-dev/immojudis`.                                                                    |
| `GITHUB_SCROLL_WORKFLOW`        | ❌      | Workflow cible. Défaut : `data-pipeline.yml`.                                                                               |
| `GITHUB_SCROLL_REF`             | ❌      | Branche cible. Défaut : `main`.                                                                                             |
| `CRON_SECRET`                   | ✅ prod | Secret Vercel Cron envoyé en `Authorization: Bearer <secret>` pour `/api/cron/smart-alerts`.                                |
| `SMART_ALERT_CRON_USER_LIMIT`   | ❌      | Nombre max d'utilisateurs Analyse évalués par exécution. Défaut : `25`.                                                     |
| `SMART_ALERT_CRON_SALE_LIMIT`   | ❌      | Nombre max de ventes actives/à venir évaluées par utilisateur. Défaut : `160`.                                              |
| `ALERT_NOTIFICATION_CRON_LIMIT` | ❌      | Nombre max de notifications d'alertes planifiées libérées par exécution. Défaut : `200`.                                    |
| `STRIPE_SECRET_KEY`             | ✅ prod | Clé serveur Stripe utilisée pour le paiement unique Analyse à 29 €.                                                         |
| `STRIPE_WEBHOOK_SECRET`         | ✅ prod | Secret de signature du webhook qui attribue les 30 jours d'accès.                                                           |
| `RESEND_API_KEY`                | ✅ prod | Clé serveur Resend pour envoyer les alertes email consenties et les emails aux avocats référencés.                          |
| `ALERT_EMAIL_FROM`              | ✅ prod | Expéditeur vérifié Resend, par exemple `ImmoJudis <alertes@immojudis.fr>`.                                                  |

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

Deux mécanismes peuvent ensuite lancer le vrai pipeline :

1. **Déclenchement immédiat** : si `GITHUB_SCROLL_TOKEN` est configuré dans Vercel, le serveur déclenche le workflow GitHub Actions `data-pipeline.yml` avec l'identifiant du run.
2. **Fallback automatique** : le workflow GitHub Actions est planifié toutes les 10 minutes et traite le plus ancien run `queued`.

Secrets à configurer dans GitHub Actions pour que le worker puisse écrire dans Supabase :

| Secret GitHub Actions       | Requis | Description                                                                                                                    |
| --------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `SUPABASE_URL`              | ✅     | URL Supabase projet `immojudis`.                                                                                               |
| `SUPABASE_SECRET_KEY`       | ✅     | Clé serveur Supabase nouvelle génération, utilisée uniquement par le worker CI.                                                |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅     | Clé serveur legacy si `SUPABASE_SECRET_KEY` n'est pas encore utilisée.                                                         |
| `SUPABASE_DB_URL`           | ✅     | URL Postgres utilisée par le workflow de migrations. Replis acceptés côté script : `POSTGRES_URL_NON_POOLING`, `POSTGRES_URL`. |
| `REPLICATE_API_TOKEN`       | ❌     | Token LLM pour l'enrichissement premium, si disponible.                                                                        |

Le token `GITHUB_SCROLL_TOKEN` côté Vercel doit être un fine-grained PAT GitHub limité au repo `Aprivi-dev/immojudis` avec accès Actions en écriture.

### Offre payante Stripe

Le checkout `/api/billing/checkout` crée un paiement unique de 29 € pour le plan
`analyse`. Le montant et la durée de 30 jours sont définis côté serveur ; aucun
Price ID récurrent n'est nécessaire. Le webhook vérifie la signature, traite
`checkout.session.completed` (et les paiements asynchrones réussis), puis inscrit
le Checkout Session dans un journal idempotent avant d'étendre l'accès de 30 jours.
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
5. Renseigner les env vars Supabase publiques dans Project Settings → Environment Variables. Optionnellement, définir `NEXT_PUBLIC_OSM_TILE_URL` pour utiliser un fournisseur de tuiles OSM dédié.
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
