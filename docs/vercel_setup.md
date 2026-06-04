# Immojudis — Déploiement

## Stack

- TanStack Start (React 19 + Vite 7)
- TypeScript strict
- Tailwind CSS v4 + shadcn/ui
- Supabase JS (auth, queries, RLS)
- Leaflet + OpenStreetMap (Mapbox compatible si token fourni)

## 1. Installation locale

```bash
bun install        # ou npm install
cp .env.example .env
# Renseigner VITE_SUPABASE_URL et VITE_SUPABASE_PUBLISHABLE_KEY
bun run dev        # http://localhost:3000
```

## 2. Variables d'environnement

| Variable                        | Requis | Description                                              |
| ------------------------------- | ------ | -------------------------------------------------------- |
| `VITE_SUPABASE_URL`             | ✅     | URL du projet Supabase (`https://xxx.supabase.co`)       |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | ✅     | Clé `anon` / `publishable` (publique, safe côté client)  |
| `VITE_MAPBOX_TOKEN`             | ❌     | Optionnel. Non utilisé en V1 (Leaflet + OSM par défaut). |

⚠️ **Ne JAMAIS** ajouter `SUPABASE_SERVICE_ROLE_KEY` au front. Elle bypass RLS.

## 3. Setup Supabase

Dans le SQL editor de ton projet Supabase, exécuter :

```
sql/vercel_app_setup.sql
```

Ce script :

- crée la vue `public.v_auction_sales_app` (filtrée sur status upcoming/unknown + lat/lng) ;
- crée les tables `public.user_favorites` et `public.user_alerts` ;
- active RLS + policies (chaque user ne voit que ses favoris/alertes) ;
- ouvre la lecture publique de `auction_sales` (SELECT only) ;
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
bun run build      # build production
bun run preview    # smoke test du build
```

## 5. Déploiement Vercel

Le scaffold cible Cloudflare par défaut (voir `vite.config.ts`), mais le
build Vite est portable. Pour Vercel :

1. Importer le repo dans Vercel.
2. Framework preset : **Vite**.
3. Build command : `bun run build` (ou `npm run build`).
4. Output directory : `dist/` (laisser auto).
5. Renseigner les env vars `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` dans Project Settings → Environment Variables.
6. Deploy.

> Note V1 : Le rendu SSR n'est pas requis pour cette app (toutes les requêtes
> Supabase sont côté client). Si Vercel n'arrive pas à servir le bundle SSR
> TanStack Start sur edge, basculer en SPA en supprimant le plugin Cloudflare
> de `vite.config.ts` et en ajoutant un rewrite `vercel.json` pour catch-all
> vers `index.html`.

## 6. Tests d'acceptation

- `/` affiche les stats (depuis Supabase)
- `/sales` liste les annonces, filtres modifient l'URL
- `/sales/:id` affiche le détail + documents
- `/map` affiche les markers Leaflet
- `/favorites` redirige vers `/login` si déconnecté
- `/alerts` permet création / toggle / suppression
- Un utilisateur ne voit JAMAIS les favoris/alertes d'un autre (RLS)
