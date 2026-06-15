# Immojudis

Frontend TanStack Start pour explorer les ventes aux enchères immobilières stockées dans Supabase.

## Installation

```bash
npm install
cp .env.example .env.local
npm run dev:ready
```

Variables minimales :

```bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-anon-key
VITE_GOOGLE_MAPS_API_KEY=your-restricted-google-maps-browser-key
```

## Scripts

```bash
npm run dev
npm run dev:ready
npm run build
npm run lint
npm run format
```

`npm run dev:ready` est le demarrage recommande en local : il lance Vite puis attend que le client Vite et les routes SSR repondent vraiment avant d'afficher l'URL. Pour chauffer une annonce precise :

```bash
npm run dev:ready -- --warm-path /sales/006999f0-cb6b-473d-baba-ff27e23d517b
```

## Supabase

Le front lit principalement la vue `public.v_auction_sales_app` et utilise les tables `user_favorites` / `user_alerts`.

Scripts SQL utiles :

- `sql/vercel_app_setup.sql`
- `sql/2026_05_update_view_app.sql`
- `supabase/migrations/20260520202829_add_geo_index.sql`
