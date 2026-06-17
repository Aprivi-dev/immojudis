# Immojudis

[![CI](https://github.com/Aprivi-dev/immojudis/actions/workflows/ci.yml/badge.svg)](https://github.com/Aprivi-dev/immojudis/actions/workflows/ci.yml)

Plateforme d'exploration des **ventes immobilières aux enchères judiciaires** en
Nouvelle-Aquitaine (Gironde, Pyrénées-Atlantiques, Landes, Dordogne,
Lot-et-Garonne). L'application aide l'investisseur à décider **jusqu'à combien
enchérir** : pour chaque bien, un assistant calcule une mise plafond à partir du
marché local (DVF), des frais, des travaux et d'une marge de sécurité, avec la
localisation (vue aérienne 3D + Street View) et les documents officiels.

Le dépôt réunit deux briques :

| Brique | Dossier | Stack | Rôle |
| --- | --- | --- | --- |
| **Application web** | racine (`src/`) | TanStack Start · React 19 · Vite 7 | Front + API serveur consommés par l'investisseur |
| **Pipeline de données** | [`services/data-pipeline/`](services/data-pipeline/README.md) | Python 3.11 | Scraping → normalisation → déduplication → Supabase |

---

## Stack technique (web)

- **Framework** : [TanStack Start](https://tanstack.com/start) (SSR + serveur Nitro) sur **Vite 7**
- **UI** : React 19, **Tailwind CSS v4**, composants [shadcn/ui](https://ui.shadcn.com) (Radix UI)
- **Routing / data** : TanStack Router (file-based) + TanStack Query
- **Backend** : [Supabase](https://supabase.com) (Postgres, Auth, RLS)
- **Cartographie** : Google Maps (Static, JavaScript, Photorealistic 3D Tiles) avec repli **Leaflet + OpenStreetMap**
- **Formulaires / validation** : react-hook-form + Zod
- **Langage** : TypeScript strict
- **Hébergement** : Vercel

## Prérequis

- **Node ≥ 20.19** (recommandé : 24, voir [`.nvmrc`](.nvmrc) — `nvm use`)
- **npm 10**
- Un projet **Supabase** (URL + clé publishable)
- *(optionnel mais recommandé)* une **clé Google Maps** restreinte par domaine

## Démarrage rapide

```bash
npm install
cp .env.example .env.local      # puis renseigner les variables (voir ci-dessous)
npm run dev                     # http://localhost:3000
```

`npm run dev:ready` est une alternative qui attend que Vite **et** les routes SSR
répondent réellement avant d'afficher l'URL. Pour préchauffer une annonce :

```bash
npm run dev:ready -- --warm-path /sales/<uuid>
```

## Variables d'environnement

| Variable | Requis | Description |
| --- | :---: | --- |
| `VITE_SUPABASE_URL` | ✅ | URL du projet Supabase (`https://xxx.supabase.co`) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | ✅ | Clé `anon` / publishable (publique, côté client) |
| `VITE_GOOGLE_MAPS_API_KEY` | ➖ | Clé navigateur Google Maps restreinte par domaine. Active vignettes, vue aérienne 3D et Street View. Sans elle : repli Leaflet/OSM. |
| `GITHUB_SCROLL_TOKEN` | ➖ | PAT GitHub fine-grained pour déclencher le workflow `data-pipeline.yml` depuis `/admin`. |

> Les variables `VITE_*` sont **inlinées au moment du build**. En production
> (Vercel) elles doivent être présentes dans *Project Settings → Environment
> Variables* **et** suivies d'un redéploiement. Voir [`docs/vercel_setup.md`](docs/vercel_setup.md)
> pour la configuration complète (Auth, secrets CI, runner admin).
>
> ⚠️ Ne jamais exposer `SUPABASE_SERVICE_ROLE_KEY` côté front : elle contourne la RLS.

### Cartographie Google — APIs à activer

La clé `VITE_GOOGLE_MAPS_API_KEY` doit avoir ces APIs **activées** dans Google
Cloud, sinon chaque surface bascule sur son repli :

| API Google Cloud | Alimente | Repli si absente |
| --- | --- | --- |
| **Maps Static API** | Vignettes des cartes (liste annonces, cartes) | Tuile OpenStreetMap |
| **Maps JavaScript API** | Carte interactive + Street View (page détail) | Placeholder « non cartographié » |
| **Map Tiles API** | Vue aérienne photoréaliste 3D (page détail) | Satellite incliné (JS API) |

La clé doit aussi autoriser les **référents HTTP** `http://localhost:3000/*` (dev)
et le domaine de production.

## Scripts

| Script | Effet |
| --- | --- |
| `npm run dev` | Serveur de dev Vite (HMR) |
| `npm run dev:ready` | Dev + attente que le client et le SSR répondent |
| `npm run build` | Build de production |
| `npm run preview` | Smoke-test du build |
| `npm run lint` | ESLint (flat config) |
| `npm run format` | Prettier (écriture) |

## Structure du dépôt

```
immojudis/
├─ src/                       # Application web (TanStack Start)
│  ├─ routes/                 # Routes file-based (/, /sales, /sales/$id, /map, /favorites, /alerts, /publish, /admin…)
│  ├─ components/             # Composants UI + cartes (SaleMap, SaleLocationHero, MapThumbnail…)
│  ├─ lib/                    # Métier : queries Supabase, format, géo, surface, google-maps, tiles
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

Le front lit principalement la vue `public.v_auction_sales_app` (annonces à venir
géolocalisées) et utilise les tables `user_favorites` / `user_alerts` protégées
par RLS. L'amorçage d'un nouveau projet se fait via
[`sql/vercel_app_setup.sql`](sql/vercel_app_setup.sql) ; l'historique des
évolutions vit dans [`supabase/migrations/`](supabase/migrations/).

## Pipeline de données

Le scraper Python collecte les ventes judiciaires publiques (Avoventes en source
prioritaire, sources publiques complémentaires en croisement), normalise,
dédoublonne, géocode, enrichit puis insère dans Supabase. Il tourne via GitHub Actions
(`data-pipeline.yml`) et peut être déclenché depuis `/admin`. Détails et
installation : [`services/data-pipeline/README.md`](services/data-pipeline/README.md).

## Déploiement

Cible : **Vercel** (preset TanStack Start). Renseigner les variables
d'environnement dans le projet Vercel puis déployer. Procédure complète (Auth
Supabase, secrets CI, runner de scroll admin) : [`docs/vercel_setup.md`](docs/vercel_setup.md).

## Intégration continue

À chaque push / PR sur `main` ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) :

- **Web** : `tsc --noEmit` + `npm run lint` (Node 24)
- **Pipeline** : `pytest` (Python 3.11)
