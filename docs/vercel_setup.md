# Immojudis — Déploiement

## Stack

- Next.js App Router (React 19)
- TypeScript strict
- Tailwind CSS v4 + shadcn/ui
- Supabase JS (auth, queries, RLS)
- Google Maps sur les pages détail et listes (vue aérienne + Street View)

## 1. Installation locale

```bash
npm install
cp .env.example .env
# Renseigner les variables NEXT_PUBLIC_* ou VITE_* compatibles
npm run dev        # http://localhost:3000
```

## 2. Variables d'environnement

| Variable                        | Requis | Description                                                                                                          |
| ------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| `VITE_SUPABASE_URL`             | ✅     | URL du projet Supabase (`https://xxx.supabase.co`)                                                                   |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | ✅     | Clé `anon` / `publishable` (publique, safe côté client)                                                              |
| `VITE_GOOGLE_MAPS_API_KEY` / `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | ❌     | Clé Google Maps restreinte par domaine. Active vignettes, carte interactive, vue aérienne et Street View ; sinon repli OSM/placeholder. |
| `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` | ❌     | Map ID JavaScript Google Maps. Active les Advanced Markers sur la carte détail. |
| `GITHUB_SCROLL_TOKEN`           | ❌     | Token GitHub finement scopé pour déclencher immédiatement le workflow de scroll depuis `/admin`.                     |
| `GITHUB_SCROLL_REPOSITORY`      | ❌     | Repo cible du workflow. Défaut : `Aprivi-dev/immojudis`.                                                             |
| `GITHUB_SCROLL_WORKFLOW`        | ❌     | Workflow cible. Défaut : `data-pipeline.yml`.                                                                        |
| `GITHUB_SCROLL_REF`             | ❌     | Branche cible. Défaut : `main`.                                                                                      |

⚠️ **Ne JAMAIS** ajouter `SUPABASE_SERVICE_ROLE_KEY` au front. Elle bypass RLS.

### Runner de scroll admin

La page `/admin` crée une ligne `auction_runs` en statut `queued`.

Deux mécanismes peuvent ensuite lancer le vrai pipeline :

1. **Déclenchement immédiat** : si `GITHUB_SCROLL_TOKEN` est configuré dans Vercel, le serveur déclenche le workflow GitHub Actions `data-pipeline.yml` avec l'identifiant du run.
2. **Fallback automatique** : le workflow GitHub Actions est planifié toutes les 10 minutes et traite le plus ancien run `queued`.

Secrets à configurer dans GitHub Actions pour que le worker puisse écrire dans Supabase :

| Secret GitHub Actions       | Requis | Description                                                |
| --------------------------- | ------ | ---------------------------------------------------------- |
| `SUPABASE_URL`              | ✅     | URL Supabase projet `immojudis`.                           |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅     | Clé serveur Supabase utilisée uniquement par le worker CI. |
| `SUPABASE_DB_URL`           | ✅     | URL Postgres utilisée par le workflow de migrations.       |
| `REPLICATE_API_TOKEN`       | ❌     | Token LLM pour l'enrichissement premium, si disponible.    |

Le token `GITHUB_SCROLL_TOKEN` côté Vercel doit être un fine-grained PAT GitHub limité au repo `Aprivi-dev/immojudis` avec accès Actions en écriture.

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
5. Renseigner les env vars Supabase publiques dans Project Settings → Environment Variables. Ajouter `VITE_GOOGLE_MAPS_API_KEY` ou `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` si Google Maps doit être actif, puis `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` pour les Advanced Markers.
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
