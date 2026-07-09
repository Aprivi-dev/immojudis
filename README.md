# Immojudis

[![CI](https://github.com/Aprivi-dev/immojudis/actions/workflows/ci.yml/badge.svg)](https://github.com/Aprivi-dev/immojudis/actions/workflows/ci.yml)

Plateforme d'exploration des **ventes immobilières aux enchères judiciaires** en
France. L'application aide l'investisseur à décider **jusqu'à combien
enchérir** : pour chaque bien, un assistant calcule une mise plafond à partir du
marché local (DVF), des frais, des travaux et d'une marge de sécurité, avec la
localisation Mapbox et les documents officiels.

Le dépôt réunit deux briques :

| Brique                  | Dossier                                                       | Stack                         | Rôle                                                |
| ----------------------- | ------------------------------------------------------------- | ----------------------------- | --------------------------------------------------- |
| **Application web**     | racine (`src/`)                                               | Next.js App Router · React 19 | Front + API serveur consommés par l'investisseur    |
| **Pipeline de données** | [`services/data-pipeline/`](services/data-pipeline/README.md) | Python 3.11                   | Scraping → normalisation → déduplication → Supabase |

---

## Stack technique (web)

- **Framework** : [Next.js App Router](https://nextjs.org/docs/app) (SSR, routes serveur et API routes)
- **UI** : React 19, **Tailwind CSS v4**, composants [shadcn/ui](https://ui.shadcn.com) (Radix UI)
- **Routing / data** : App Router Next.js + adaptateur de compatibilité pour les anciennes routes + TanStack Query
- **Backend** : [Supabase](https://supabase.com) (Postgres, Auth, RLS)
- **Cartographie** : Mapbox GL JS + Mapbox Static Images, avec fallback OSM legacy
- **Formulaires / validation** : formulaires natifs + Zod
- **Langage** : TypeScript strict
- **Hébergement** : Vercel

## Prérequis

- **Node ≥ 20.19** (recommandé : 24, voir [`.nvmrc`](.nvmrc) — `nvm use`)
- **npm 10**
- Un projet **Supabase** (URL + clé publishable)

## Démarrage rapide

```bash
npm install
cp .env.example .env.local      # puis renseigner les variables (voir ci-dessous)
npm run dev                     # http://localhost:3000
```

`npm run dev:ready` est une alternative qui attend que Next.js **et** les routes SSR
répondent réellement avant d'afficher l'URL. Pour préchauffer une annonce :

```bash
npm run dev:ready -- --warm-path /sales/<uuid>
```

## Variables d'environnement

| Variable                          | Requis | Description                                                                                            |
| --------------------------------- | :----: | ------------------------------------------------------------------------------------------------------ |
| `VITE_SUPABASE_URL`               |   ✅   | URL du projet Supabase (`https://xxx.supabase.co`)                                                     |
| `VITE_SUPABASE_PUBLISHABLE_KEY`   |   ✅   | Clé `anon` / publishable (publique, côté client)                                                       |
| `SUPABASE_SECRET_KEY`             |   ✅   | Clé serveur Supabase pour les API routes, ou `SUPABASE_SERVICE_ROLE_KEY` sur les projets legacy        |
| `SUPABASE_DB_URL`                 |   ✅   | URL Postgres directe pour les migrations. Replis acceptés : `POSTGRES_URL_NON_POOLING`, `POSTGRES_URL` |
| `CRON_SECRET`                     |   ✅   | Secret utilisé par les routes Vercel Cron                                                              |
| `RESEND_API_KEY`                  |   ✅   | Clé serveur Resend pour envoyer les alertes email consenties et les emails aux avocats référencés      |
| `ALERT_EMAIL_FROM`                |   ✅   | Expéditeur vérifié Resend, par exemple `ImmoJudis <alertes@immojudis.fr>`                              |
| `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` |   ➖   | Token public Mapbox utilisé par Mapbox GL JS et les mini-cartes statiques.                             |
| `NEXT_PUBLIC_MAPBOX_STYLE`        |   ➖   | Style Mapbox, par exemple `mapbox/streets-v12` ou `mapbox://styles/<user>/<style>`.                    |
| `NEXT_PUBLIC_OSM_TILE_URL`        |   ➖   | Fallback legacy de tuiles OSM compatible `{z}/{x}/{y}` si Mapbox est absent ou indisponible.           |
| `GITHUB_SCROLL_TOKEN`             |   ➖   | PAT GitHub fine-grained pour déclencher le workflow `data-pipeline.yml` depuis `/admin`.               |

> Les variables `VITE_*` sont **inlinées au moment du build**. En production
> (Vercel) elles doivent être présentes dans _Project Settings → Environment
> Variables_ **et** suivies d'un redéploiement. Voir [`docs/vercel_setup.md`](docs/vercel_setup.md)
> pour la configuration complète (Auth, secrets CI, runner admin).
>
> `npm run env:check:prod` vérifie les groupes de variables nécessaires aux API
> serveur et aux migrations avant un déploiement complet.
> Si Vercel marque des variables comme sensibles, leurs valeurs peuvent rester
> illisibles localement : le check valide alors leur présence déclarée, mais
> `npm run db:migrate` exige toujours une URL Postgres réellement disponible.
>
> ⚠️ Ne jamais exposer `SUPABASE_SECRET_KEY` ou `SUPABASE_SERVICE_ROLE_KEY` côté
> front : elles contournent la RLS.

### Cartographie Mapbox

La page `/sales` utilise Mapbox GL JS pour la carte interactive : source
GeoJSON, clusters natifs, marqueurs de prix, popups enrichies et synchronisation
de la bbox avec la liste de biens. Les mini-cartes affichées ailleurs dans le
site utilisent Mapbox Static Images pour rester rapides et économes en JavaScript.
Le filtre "autour d'une adresse" utilise Mapbox Geocoding v6 en priorité
(`country=fr`, `language=fr`, `types=address,street,postcode,place,locality,neighborhood`),
puis l'API adresse française en secours.

Configurez `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` et, si besoin,
`NEXT_PUBLIC_MAPBOX_STYLE`. Le style par défaut est `mapbox/streets-v12`.
`NEXT_PUBLIC_OSM_TILE_URL` reste disponible comme fallback legacy pour les vues
qui utilisent encore une tuile statique compatible OSM lorsque Mapbox est absent.

## Scripts

| Script                   | Effet                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `npm run dev`            | Serveur de dev Next.js (HMR)                                                                                  |
| `npm run dev:ready`      | Dev + attente que le client et le SSR répondent                                                               |
| `npm run build`          | Build de production                                                                                           |
| `npm run preview`        | Smoke-test du build                                                                                           |
| `npm run test`           | Tests unitaires Vitest                                                                                        |
| `npm run lint`           | ESLint (flat config)                                                                                          |
| `npm run env:check:prod` | Vérifie les variables nécessaires aux API prod + migrations                                                   |
| `npm run db:migrate`     | Applique les migrations Supabase en attente (`SUPABASE_DB_URL`, `POSTGRES_URL_NON_POOLING` ou `POSTGRES_URL`) |
| `npm run format`         | Prettier (écriture)                                                                                           |

## Structure du dépôt

```
immojudis/
├─ src/                       # Application web (Next.js App Router)
│  ├─ app/                    # Routes Next.js (/, /sales, /sales/[id], /publish, /admin…)
│  ├─ routes/                 # Anciennes routes client conservées via compatibilité
│  ├─ components/             # Composants UI + localisation (SaleLocationHero, MapThumbnail…)
│  ├─ lib/                    # Métier : queries Supabase, format, géo, surface, tiles
│  ├─ hooks/                  # Hooks React
│  ├─ integrations/           # Client Supabase et intégrations
│  └─ types/                  # Types partagés
├─ services/data-pipeline/    # Pipeline Python (scraping → Supabase) — voir son README
├─ supabase/migrations/       # Migrations SQL versionnées
├─ sql/                       # Scripts d'amorçage à exécuter dans Supabase (vercel_app_setup.sql)
├─ docs/                      # Documentation déploiement / ops
├─ scripts/                   # Outils de dev (dev-ready)
└─ .github/workflows/         # CI : web (typecheck + lint) · pipeline (pytest)
```

## Base de données (Supabase)

Le front lit `public.v_auction_sales_app_preview` pour l'aperçu public limité,
puis `public.v_auction_sales_app` pour les comptes connectés. Les détails
d'annonce, documents, risques, cartes et tables `user_favorites` / `user_alerts`
sont protégés par RLS. L'amorçage d'un nouveau projet se fait via
[`sql/vercel_app_setup.sql`](sql/vercel_app_setup.sql) ; l'historique des
évolutions vit dans [`supabase/migrations/`](supabase/migrations/) et s'applique
avec le workflow GitHub `Apply Supabase Migrations` ou `npm run db:migrate`.
Les droits admin reposent sur `auth.users.raw_app_meta_data.role = admin`.

## Pipeline de données

Le scraper Python collecte les ventes judiciaires publiques (Avoventes en source
prioritaire, sources publiques complémentaires en croisement), normalise,
dédoublonne, géocode, enrichit puis insère dans Supabase. Il tourne via GitHub Actions
(`data-pipeline.yml`) et peut être déclenché depuis `/admin`. Détails et
installation : [`services/data-pipeline/README.md`](services/data-pipeline/README.md).

## Déploiement

Cible : **Vercel** (preset Next.js). Renseigner les variables
d'environnement dans le projet Vercel puis déployer. Procédure complète (Auth
Supabase, secrets CI, runner de scroll admin) : [`docs/vercel_setup.md`](docs/vercel_setup.md).

## Intégration continue

À chaque push / PR sur `main` ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) :

- **Web** : `tsc --noEmit` + `npm run lint` + `npm run test` + `npm run build` (Node 24)
- **Pipeline** : `ruff check` + `pytest` (Python 3.11)
