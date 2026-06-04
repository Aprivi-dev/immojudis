# Firebase Studio Migration

This project is ready to be imported into Firebase Studio as a standalone frontend workspace.

## Stack

- TanStack Start
- React 19
- Vite 7
- Tailwind CSS 4
- Supabase client-side queries and auth
- Leaflet/OpenStreetMap maps
- Bun package manager

## What Changed For Firebase Studio

- Added `.idx/dev.nix` for the Firebase Studio workspace.
- Removed the hardcoded Supabase URL and anon key from `src/integrations/supabase/client.ts`.
- Added server-side Supabase variables to `.env.example`.
- Hardened `.gitignore` so local `.env` files are not committed.

## Import Flow

1. Create a new private GitHub repository for this app.
2. Push this folder as the repository root.
3. Open Firebase Studio.
4. Choose `Import project`.
5. Select the GitHub repository.
6. Wait for the `.idx/dev.nix` setup to run `bun install`.

## Environment Variables

Create `.env` in Firebase Studio from `.env.example`.

Required for browser queries:

```bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-anon-key
```

Optional for server middleware/routes:

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=your-publishable-anon-key
SUPABASE_SERVICE_ROLE_KEY=
```

Optional map token:

```bash
VITE_MAPBOX_TOKEN=
```

Never expose `SUPABASE_SERVICE_ROLE_KEY` in browser code.

## Commands

```bash
bun install
bun run dev
bun run lint
bun run build
```

## Supabase Checklist

Run these SQL scripts in Supabase if not already applied:

- `sql/vercel_app_setup.sql`
- `sql/2026_05_update_view_app.sql`
- `supabase/migrations/20260520202829_add_geo_index.sql`

Supabase Auth URL configuration should include:

- Firebase Studio preview URL
- local preview URL, if used
- future production domain

## Notes

The app still uses Supabase as its data backend. Firebase Studio is used here as the cloud development environment, not as a replacement database.
