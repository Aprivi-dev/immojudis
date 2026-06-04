# Immojudis — Déploiement

## Stack

- TanStack Start (React 19 + Vite 7)
- TypeScript strict
- Tailwind CSS v4 + shadcn/ui
- Supabase JS (auth, queries, RLS)
- Leaflet + OpenStreetMap (Mapbox compatible si token fourni)

## 1. Installation locale

```bash
npm install
cp .env.example .env
# Renseigner VITE_SUPABASE_URL et VITE_SUPABASE_PUBLISHABLE_KEY
npm run dev        # http://localhost:3000
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
npm run build      # build production
npm run preview    # smoke test du build
```

## 5. Déploiement Vercel

Le projet cible Vercel. Pour déployer :

1. Importer le repo dans Vercel.
2. Framework preset : **Vite**.
3. Build command : `npm run build`.
4. Output directory : laisser la valeur auto générée par TanStack Start/Vite.
5. Renseigner les env vars `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` dans Project Settings → Environment Variables.
6. Deploy.

> Note : le projet est configuré avec TanStack Start et Nitro pour générer le
> serveur Vercel. Les variables Supabase publiques restent injectées via
> `VITE_*`.

## 6. Tests d'acceptation

- `/` affiche les stats (depuis Supabase)
- `/sales` liste les annonces, filtres modifient l'URL
- `/sales/:id` affiche le détail + documents
- `/map` affiche les markers Leaflet
- `/favorites` redirige vers `/login` si déconnecté
- `/alerts` permet création / toggle / suppression
- Un utilisateur ne voit JAMAIS les favoris/alertes d'un autre (RLS)
