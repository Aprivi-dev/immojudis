import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

// Le chunk de mapbox-gl a son budget propre. Relevé de 1 850 000 le 12/10/2026 (accord du
// propriétaire) : la mise à jour des dépendances #196 (next 16.4, mapbox-gl 3.32) l'avait grossi
// de 11 ko ; plafond de 1 875 000 (marge de 1,35 %).
// Mesuré le 20/10/2026 : 1 869 846 octets, soit 99,72 % du plafond (5 154 octets de marge, effet de
// la mise à jour #279). Garder la même marge relative sur la mesure d'aujourd'hui donnerait environ
// 1 895 000 : ce serait RELEVER le plafond, ce que seul le propriétaire peut décider. Le plafond est
// donc inchangé ; la prochaine mise à jour de mapbox-gl le fera échouer tant qu'il n'est pas relevé
// avec son accord. Le chunk est reconnu à la bannière de licence de la bibliothèque (voir
// `isMapboxChunk`) ; sans bannière trouvée, il retombe sous le budget des autres chunks et fait
// échouer le contrôle (jamais de plafond large par défaut).
const MAX_MAPBOX_CHUNK_BYTES = 1_875_000;
// Tous les autres chunks : le plus gros mesure 284 721 octets le 20/10/2026 ; plafond à la mesure
// + 15 % (resserré : l'ancien plafond unique, 1 875 000, couvrait tout).
const MAX_CLIENT_CHUNK_BYTES = 330_000;
// The protected admin editor adds an isolated client route; keep a small global
// allowance for it while enforcing a dedicated initial-load budget below.
// Separate favorites and alerts routes add independently loaded client chunks.
// The tribunal statistics explorer adds a dedicated, premium-only client view.
// Keep its global allowance narrow; route-level initial-load budgets remain enforced.
// The three procedure-specific pilot workspaces add client code to the sale detail view.
// The Annonce refactor adds financing and urbanism panels across sale detail routes.
// The supervised fact review, source refresh controls, and secure contribution form add a
// bounded private/support surface to the all-chunk total. Keep a narrow allowance for that
// workflow while the route-level initial-load budgets below continue to protect public pages.
// The AI review projection and quarantine guard add a similarly bounded shared client surface.
// Keep the allowance below 1% of the total and enforce every route budget independently.
// The corrected build measured 4,647,456 bytes against the 4,708,892-byte
// release baseline, so keep the ceiling below that baseline with headroom.
//
// The corrective release (bid-ceiling assistant, acquisition-cost model,
// rebuilt example listing, favourites/alerts digests, consent and trial flows)
// measured 5,004,731 bytes with the security phase (MFA gate, CSP reporting). The ceiling is raised once, to 5,100,000, with the
// per-route initial-load budgets below left as the real guard for public pages.
// The security phase (TOTP gate, CSP reporting, privacy erasure UI) added ~28 KB to every
// route's shared bundle (measured 5,060,537 bytes in total): budgets are raised once.
//
// P3-11 splits the administration into one page per view. Each page now carries
// its own copy of the shared console frame (AdminShell and its icons), so the
// all-chunks total grows (5,004,731 -> 5,144,513 bytes measured) while every
// admin page loads LESS: initial JavaScript fell from 566,921 bytes (all views
// in every page) to 470,093-537,561 bytes. The ceiling is raised once, to
// 5,200,000, and each admin view gets its own initial-load budget below.
//
// The Analyse « Lecture des pièces » and « Historique de la vente » sections add two
// panels to the shared sale detail chunk (measured 5,305,601 bytes in total, no
// duplication across routes). The ceiling is raised once, to 5,350,000; the route-level
// initial-load budgets below are unchanged.
//
// The first team session (October 2026) adds the public fees simulator, the ceiling
// glossary and context line, the mobile comparison and empty-search actions, the
// opening-request and checkout-return states of /offres, and the anonymous journey
// events (one small module shared by nine route chunks). Measured 5,362,400 bytes in
// total; the home page itself went DOWN to 525,931 bytes once the consent strings were
// split from the zod schema. The ceiling is raised once, to 5,400,000; every route-level
// initial-load budget below is unchanged.
//
// « 3 déblocages par mois » (PR #243) adds the unlock panel, the unlocked sale detail view
// and the reduced ceiling estimate to the sale detail chunks. Measured 5,402,556 bytes in
// total. The ceiling is raised once, to 5,450,000; every route-level initial-load budget
// below is unchanged and still passes.
//
// The adjuge.info batch (October 2026) adds the reverse fees simulator and surenchère
// calculator, the departments pages, the sale key-facts band and the optional results
// table of /sales (desktop only). Measured 5,456,599 bytes in total. The ceiling is raised
// once, to 5,500,000; every route-level initial-load budget below is unchanged.
//
// The 18/10 team session (October 2026) adds the launch offer (provider, notes, admin
// switch), the qualified opening waitlist, the /tribunaux/[slug] and /audiences-a-venir
// pages and three resource articles, while Sonner moves to an on-demand chunk (-34 kB on
// every page). Measured 5,601,873 bytes in total before the /sales and account batches.
// The owner approved (19/10/2026) raising the ceiling once, to 5,750,000; every
// route-level initial-load budget below is unchanged and still passes.
// The account, alerts and reminders batch (/alertes/creer, sector alerts, /compte toggles,
// mostly on-demand chunks) then measured 5,788,672 bytes; the owner approved (19/10/2026)
// a second raise, to 5,850,000. The home page still loads 714,554 of its 735,000 bytes.
// The second wave (account events and /admin/pilotage, free sale dossier, past followed sales,
// public market-gap band, financing page, points-to-verify badge) then measured 5,879,382
// bytes, mostly on-demand chunks; the owner approved (19/10/2026) a third raise, to 5,950,000.
// The session of 20/10/2026 (waiting-list notifier, pilotage v2, sale dossier entry, launch-offer
// surfaces) measured 5,964,934 bytes while every page budget passed and the initial JavaScript of
// public pages went down; the owner approved (20/10/2026) a fourth raise, to 6,000,000.
// The second wave of the same day (start checklist, followed-sale planning, signal feedback, search
// filters, lawyer statement, works breakdown, weekly digest and result emails) measured 6,075,737
// bytes, mostly on-demand chunks with every page budget passing; the owner approved (20/10/2026) a
// fifth raise, to 6,125,000.
// The ten work sites of 23/10/2026 (aerial view, scenarios, PLU panel, consent, information agent,
// pending alert after sign-up…) measured 6,164,297 bytes with every page budget passing except
// admin-lawyers; the owner approved (23/10/2026) a sixth raise, to 6,165,000. The review fixes of the
// same day (alert criteria labels, consent texts) measured 6,166,442 bytes in CI; the owner approved
// (23/10/2026) a seventh raise, to 6,170,000. The second wave of 23/10/2026 (seven price bands,
// estimate snapshots, photo / 360° selector, launch-offer end notice, ceiling against the court,
// questions for the lawyer, stale ceiling) measured 6,197,582 bytes; the owner approved (23/10/2026)
// an eighth raise, to 6,200,000.
// Migration vers zod 4 (24/10/2026, alerte GHSA-mrhx-c7xc-m3w5 sur zod 3) : le bloc client partagé
// de zod passe de 56 149 à 113 987 octets ; total mesuré 6 256 865. Le propriétaire a approuvé
// (24/10/2026) un neuvième relèvement, à 6 260 000, et ceux des routes qui chargent ce bloc. Ce poids
// est à récupérer en passant les schémas envoyés au navigateur sur zod/mini. C'est fait (24/10/2026) :
// total mesuré 6 118 970, le plafond revient à 6 200 000.
// Lot B1 des pépites (26/10/2026) : la page /admin/pepites (2,9 Ko de JavaScript, le reste est mis en forme
// côté serveur), le bouton « Suspendre les pépites », la carte « Repère Pépite » de /admin/pilotage et le
// signal « pepite » des retours ajoutent 6 926 octets au total (mesuré 6 201 854 pour 6 194 928 avant).
// Décision du fondateur (26/10/2026) : relèvement du total de 20 000 octets, à 6 220 000, pour ce lot et le
// suivant (B2, affichage du repère). Le plafond du plus gros chunk (+10 000 octets au plus, pour la fiche et
// les favoris) n'est pas relevé dans ce lot : aucun chunk n'a grossi ; il se relèvera avec B2 si besoin.
const MAX_TOTAL_CLIENT_JS_BYTES = 6_220_000;
const MAX_LANDING_IMAGE_BYTES = 350_000;
// New homepage: lossless panorama for large screens plus editorial photography.
const MAX_PUBLIC_MEDIA_BYTES = 5_000_000;
const HOMEPAGE_IMAGE_BUDGETS = {
  "public/media/landing/cinematic-bordeaux-lossless.webp": 2_300_000,
  "public/media/landing/gallery-townhouse.webp": 460_000,
  "public/media/landing/gallery-land.webp": 460_000,
};
const MAX_BUSINESS_MODULE_LINES = 1_500;

// P6-05: the 1,500-line limit applies to EVERY src/**/*.{ts,tsx} file (tests excluded).
// A file that still exceeds it must be listed here, with a reason and an expiry date;
// once the date is past the exception stops applying and the build fails until the file
// is split. Do not add an entry to dodge a split: split the file instead.
const LINE_LIMIT_EXCEPTIONS_UNTIL = "2026-12-31";
const LINE_LIMIT_EXCEPTIONS = {
  // Generated by `npm run db:types` (supabase gen types): splitting it by hand would be
  // overwritten at the next generation. Temporary until the generator output is split per
  // schema area or the file is excluded from the repository budget by a dedicated decision.
  "src/integrations/supabase/types.ts": LINE_LIMIT_EXCEPTIONS_UNTIL,
};

const businessModules = [
  "src/components/search/SearchPage.tsx",
  "src/components/search/SearchFilters.tsx",
  "src/components/search/SearchHeader.tsx",
  "src/components/search/SearchResults.tsx",
  "src/components/search/search-page-state.ts",
  "src/lib/property-reports.ts",
  "src/lib/property-report/analysis.ts",
  "src/lib/property-report/entitlements.ts",
  "src/lib/property-report/pdf.ts",
  "src/lib/property-report/repository.ts",
  "src/lib/property-report/serialization.ts",
  "services/data-pipeline/src/asset_normalization.py",
  "services/data-pipeline/src/asset_normalization_helpers.py",
  "services/data-pipeline/src/asset_premium_analysis.py",
  "services/data-pipeline/src/asset_scoring.py",
  "services/data-pipeline/src/asset_surface_normalization.py",
  "services/data-pipeline/src/pdf_document_types.py",
  "services/data-pipeline/src/pdf_document_selection.py",
  "services/data-pipeline/src/pdf_enrichment.py",
  "services/data-pipeline/src/pdf_word_documents.py",
  "services/data-pipeline/src/pdf_page_analysis.py",
  "services/data-pipeline/src/pdf_fact_extraction.py",
  "services/data-pipeline/src/pdf_fact_scope.py",
  "services/data-pipeline/src/pdf_ocr.py",
  "services/data-pipeline/src/pdf_failure_diagnostics.py",
  "services/data-pipeline/src/pdf_progress.py",
  "services/data-pipeline/src/encheres_publiques_guard.py",
  "services/data-pipeline/src/source_task_deadline.py",
  "services/data-pipeline/src/llm_task_deadline.py",
];

// Budgets de route resserrés le 20/10/2026 à la mesure + 15 % (+ 10 % pour les deux pages ajoutées),
// arrondie aux 5 000 octets au-dessus : les anciens plafonds, posés avant l'allègement du
// JavaScript commun, laissaient jusqu'à 55 % de marge (accueil mesuré 242 685 pour 555 000).
// Mesures : alertes 440 145, accueil 242 685, catalogue 485 970, fiche 318 622, tribunaux 331 468,
// exemple 160 428, offres 216 453, pages /admin 419 893 à 457 472 ; favoris (612 016) garde son
// plafond de 670 000, dont la mesure + 15 % donnerait plus. Aucun plafond n'est relevé : tout
// relèvement demande l'accord du propriétaire.
const routeBudgets = [
  {
    name: "favorites",
    manifest: ".next/server/app/favoris/page_client-reference-manifest.js",
    routeKey: "/favoris/page",
    entryKey: "[project]/src/app/favoris/page",
    // zod 4 puis zod/mini : 660 222 octets (24/10/2026), plafond d'origine rétabli.
    maxBytes: 670_000,
  },
  {
    name: "alerts",
    manifest: ".next/server/app/alertes/page_client-reference-manifest.js",
    routeKey: "/alertes/page",
    entryKey: "[project]/src/app/alertes/page",
    maxBytes: 510_000,
  },
  {
    name: "home",
    manifest: ".next/server/app/page_client-reference-manifest.js",
    routeKey: "/page",
    entryKey: "[project]/src/app/page",
    maxBytes: 280_000,
  },
  {
    name: "sales",
    manifest: ".next/server/app/sales/page_client-reference-manifest.js",
    routeKey: "/sales/page",
    entryKey: "[project]/src/app/sales/page",
    // zod 4 puis zod/mini : 522 993 octets (24/10/2026), plafond d'origine rétabli.
    maxBytes: 560_000,
  },
  {
    name: "sale-detail",
    manifest: ".next/server/app/sales/[id]/page_client-reference-manifest.js",
    routeKey: "/sales/[id]/page",
    entryKey: "[project]/src/app/sales/[id]/page",
    // zod 4 puis zod/mini : 363 784 octets (24/10/2026), plafond d'origine rétabli.
    maxBytes: 370_000,
  },
  {
    name: "tribunals",
    manifest: ".next/server/app/tribunaux/page_client-reference-manifest.js",
    routeKey: "/tribunaux/page",
    entryKey: "[project]/src/app/tribunaux/page",
    // zod 4 puis zod/mini : 350 611 octets (24/10/2026), plafond d'origine rétabli.
    maxBytes: 385_000,
  },
  // Pages ajoutées par la session du 18/10 : budget à la mesure du 20/10/2026 + 10 %
  // (171 731 et 164 138 octets).
  {
    name: "tribunal-page",
    manifest: ".next/server/app/tribunaux/[slug]/page_client-reference-manifest.js",
    routeKey: "/tribunaux/[slug]/page",
    entryKey: "[project]/src/app/tribunaux/[slug]/page",
    maxBytes: 189_000,
  },
  {
    name: "hearings",
    manifest: ".next/server/app/audiences-a-venir/page_client-reference-manifest.js",
    routeKey: "/audiences-a-venir/page",
    entryKey: "[project]/src/app/audiences-a-venir/page",
    // 181,521 bytes after the second wave of 23/10/2026: raised to 182,000 with the owner's approval.
    maxBytes: 182_000,
  },
  {
    name: "example",
    manifest: ".next/server/app/annonce-exemple/page_client-reference-manifest.js",
    routeKey: "/annonce-exemple/page",
    entryKey: "[project]/src/app/annonce-exemple/page",
    maxBytes: 185_000,
  },
  {
    name: "pricing",
    manifest: ".next/server/app/offres/page_client-reference-manifest.js",
    routeKey: "/offres/page",
    entryKey: "[project]/src/app/offres/page",
    maxBytes: 250_000,
  },
  // Administration: one page per view (P3-11). Measured 470-538 KB each, against
  // 566,921 bytes for every view before the split.
  {
    name: "admin-home",
    manifest: ".next/server/app/admin/page_client-reference-manifest.js",
    routeKey: "/admin/page",
    entryKey: "[project]/src/app/admin/page",
    maxBytes: 505_000,
  },
  {
    name: "admin-operations",
    manifest: ".next/server/app/admin/operations/page_client-reference-manifest.js",
    routeKey: "/admin/operations/page",
    entryKey: "[project]/src/app/admin/operations/page",
    maxBytes: 530_000,
  },
  {
    name: "admin-agent",
    manifest: ".next/server/app/admin/agent-ia/page_client-reference-manifest.js",
    routeKey: "/admin/agent-ia/page",
    entryKey: "[project]/src/app/admin/agent-ia/page",
    maxBytes: 485_000,
  },
  {
    name: "admin-publications",
    manifest: ".next/server/app/admin/publications/page_client-reference-manifest.js",
    routeKey: "/admin/publications/page",
    entryKey: "[project]/src/app/admin/publications/page",
    maxBytes: 505_000,
  },
  {
    name: "admin-clients",
    manifest: ".next/server/app/admin/clients/page_client-reference-manifest.js",
    routeKey: "/admin/clients/page",
    entryKey: "[project]/src/app/admin/clients/page",
    maxBytes: 515_000,
  },
  {
    name: "admin-pilotage",
    manifest: ".next/server/app/admin/pilotage/page_client-reference-manifest.js",
    routeKey: "/admin/pilotage/page",
    entryKey: "[project]/src/app/admin/pilotage/page",
    // 20/10/2026 : resserré de 540 000 à 500 000 par W8, puis porté à 520 000 (sous le plafond d'origine)
    // par les cartes de la seconde vague (rappels, retours sur les signaux). zod 4 puis zod/mini :
    // 457 936 octets (24/10/2026), plafond de 520 000 rétabli.
    maxBytes: 520_000,
  },
  {
    name: "admin-lawyers",
    manifest: ".next/server/app/admin/lawyers/page_client-reference-manifest.js",
    routeKey: "/admin/lawyers/page",
    entryKey: "[project]/src/app/admin/lawyers/page",
    // 534,843 bytes on 23/10/2026 (pending alert after sign-up in the shared providers, consent
    // state): the owner approved (23/10/2026) raising this budget from 530,000 to 535,000. The second
    // wave of the same day measured 536,104 bytes: raised to 537,000 with the owner's approval.
    // zod 4 measured 594,371 bytes on 24/10/2026 (raised to 596,000 with the owner's approval); with
    // the browser schemas on zod/mini, 544,436 bytes: the zod/mini chunk (63,759 bytes) is still
    // 7,610 bytes above zod 3's, so the budget comes back down to 546,000 only.
    maxBytes: 546_000,
  },
  {
    name: "admin-compliance",
    manifest: ".next/server/app/admin/compliance/page_client-reference-manifest.js",
    routeKey: "/admin/compliance/page",
    entryKey: "[project]/src/app/admin/compliance/page",
    maxBytes: 520_000,
  },
];

// JavaScript réellement référencé par le HTML préfabriqué d'une page publique (balises
// <script src> hors `nomodule`) : socle commun à toutes les routes (React, Next, runtime,
// en-tête, fournisseurs) plus le code propre à la page. Les budgets de route ci-dessus ne
// comptent que les fichiers propres à la page (`entryJSFiles`) et ne voient donc pas ce socle.
// Avant l'allègement du JavaScript commun (V7 de l'audit de vitesse, `supabase-js` chargé à la
// demande, Analytics et menu « Mon compte » différés) : accueil 998 093 octets, guide 910 095,
// article 924 937. Après : 720 427, 632 403 et 647 245. Les plafonds ci-dessous laissent ~2 % de
// marge sur la mesure après. Ne relevez pas un plafond sans accord du propriétaire.
//
// Piège mesuré : ne pas charger par `import()` un module aussi importé statiquement par d'autres
// pages (Sonner, Radix Dialog). Turbopack en recopie alors le code dans chacun de leurs fichiers
// (Sonner : 13 copies, +600 Ko au total) au lieu de le partager avec le socle commun.
const htmlScriptBudgets = [
  { name: "home", html: ".next/server/app/index.html", maxBytes: 735_000 },
  {
    name: "guide",
    html: ".next/server/app/ventes-immobilieres-judiciaires.html",
    maxBytes: 645_000,
  },
  // Premier article préfabriqué par ordre alphabétique (le slug exact importe peu).
  { name: "article", htmlDirectory: ".next/server/app/ressources", maxBytes: 660_000 },
];

await checkSourceLineLimits();

const requiredHtml = [[".next/server/app/index.html", "en toute"]];

for (const [path, expectedText] of requiredHtml) {
  const html = await readFile(path, "utf8");
  if (!html.includes("<h1") || !html.includes(expectedText)) {
    throw new Error(`${path} ne contient pas le HTML SSR utile attendu (${expectedText}).`);
  }
}

// /sales and /annonce-exemple are rendered on demand (they read the search
// parameters; the example's dates are computed at request time): there is no
// prerendered HTML to inspect, only the server entry that must exist.
await readFile(".next/server/app/sales/page.js", "utf8");
await readFile(".next/server/app/annonce-exemple/page.js", "utf8");

await checkSingleFont();

const businessModuleLines = Object.fromEntries(
  await Promise.all(
    businessModules.map(async (path) => {
      const source = await readFile(path, "utf8");
      const lines = source.split(/\r?\n/u).length;
      if (lines > MAX_BUSINESS_MODULE_LINES) {
        throw new Error(
          `Module métier trop long: ${path} (${lines} lignes > ${MAX_BUSINESS_MODULE_LINES}).`,
        );
      }
      return [path, lines];
    }),
  ),
);

const chunks = await filesUnder(".next/static/chunks", (path) => path.endsWith(".js"));
const chunkSizes = await Promise.all(
  chunks.map(async (path) => [path, (await stat(path)).size, await isMapboxChunk(path)]),
);
const totalClientBytes = chunkSizes.reduce((sum, [, size]) => sum + size, 0);
const [largestChunk, largestChunkBytes] = [...chunkSizes].sort(
  (left, right) => right[1] - left[1],
)[0] ?? ["none", 0];
const mapboxChunks = chunkSizes.filter(([, , mapbox]) => mapbox);
const [mapboxChunk, mapboxChunkBytes] = [...mapboxChunks].sort(
  (left, right) => right[1] - left[1],
)[0] ?? ["none", 0];
const [largestOtherChunk, largestOtherChunkBytes] = [
  ...chunkSizes.filter(([, , mapbox]) => !mapbox),
].sort((left, right) => right[1] - left[1])[0] ?? ["none", 0];

if (mapboxChunkBytes > MAX_MAPBOX_CHUNK_BYTES) {
  throw new Error(
    `Chunk mapbox-gl trop lourd: ${mapboxChunk} (${mapboxChunkBytes} octets > ${MAX_MAPBOX_CHUNK_BYTES}). Relever ce plafond demande l'accord du propriétaire.`,
  );
}
if (largestOtherChunkBytes > MAX_CLIENT_CHUNK_BYTES) {
  throw new Error(
    `Chunk client trop lourd: ${largestOtherChunk} (${largestOtherChunkBytes} octets > ${MAX_CLIENT_CHUNK_BYTES}).`,
  );
}
const routeClientBytes = {};
for (const budget of routeBudgets) {
  const bytes = await clientJavaScriptBytesForRoute(budget);
  routeClientBytes[budget.name] = bytes;
  if (bytes > budget.maxBytes) {
    throw new Error(
      `JavaScript initial trop lourd pour ${budget.name}: ${bytes} octets > ${budget.maxBytes}.`,
    );
  }
}

const htmlScriptBytesByPage = {};
for (const budget of htmlScriptBudgets) {
  const bytes = await htmlReferencedJavaScriptBytes(await resolveHtmlPath(budget));
  htmlScriptBytesByPage[budget.name] = bytes;
  if (bytes > budget.maxBytes) {
    throw new Error(
      `JavaScript référencé par le HTML trop lourd pour ${budget.name}: ${bytes} octets > ${budget.maxBytes}.`,
    );
  }
}

if (totalClientBytes > MAX_TOTAL_CLIENT_JS_BYTES) {
  throw new Error(
    `JavaScript client total trop lourd: ${totalClientBytes} octets > ${MAX_TOTAL_CLIENT_JS_BYTES}.`,
  );
}

const landingImages = await filesUnder("public/media/landing", (path) => path.endsWith(".webp"));
for (const path of landingImages) {
  const bytes = (await stat(path)).size;
  if (bytes > (HOMEPAGE_IMAGE_BUDGETS[path] ?? MAX_LANDING_IMAGE_BYTES)) {
    throw new Error(`Image landing trop lourde: ${path} (${bytes} octets).`);
  }
}

const publicMedia = await filesUnder("public/media", () => true);
const publicMediaBytes = (
  await Promise.all(publicMedia.map(async (path) => (await stat(path)).size))
).reduce((sum, bytes) => sum + bytes, 0);
if (publicMediaBytes > MAX_PUBLIC_MEDIA_BYTES) {
  throw new Error(
    `Médias publics trop lourds: ${publicMediaBytes} octets > ${MAX_PUBLIC_MEDIA_BYTES}.`,
  );
}

const legacyMedia = publicMedia.filter((path) => /\.(?:jpe?g|png|mp4)$/i.test(path));
if (legacyMedia.length > 0) {
  throw new Error(`Médias sources non optimisés encore publiés: ${legacyMedia.join(", ")}.`);
}

console.info(
  JSON.stringify({
    largestChunk,
    largestChunkBytes,
    mapboxChunk,
    mapboxChunkBytes,
    largestOtherChunk,
    largestOtherChunkBytes,
    landingWebpCount: landingImages.length,
    largestBusinessModuleLines: Math.max(...Object.values(businessModuleLines)),
    htmlScriptBytesByPage,
    publicMediaBytes,
    routeClientBytes,
    totalClientBytes,
  }),
);

/**
 * La police du site, mesurée sur le build et non sur le code source : Manrope seule (25/10/2026).
 * - un seul fichier de police dans `_next/static/media` ;
 * - aucune règle `@font-face` italique dans les feuilles de style ;
 * - l'accueil et /sales (variante statique) préchargent ce fichier, une seule fois.
 */
async function checkSingleFont() {
  const media = await readdir(".next/static/media");
  const fontFiles = media.filter((name) => /\.(?:woff2?|ttf|otf)$/iu.test(name));
  if (fontFiles.length !== 1) {
    throw new Error(
      `Un seul fichier de police attendu dans .next/static/media, trouvé : ${fontFiles.join(", ") || "aucun"}.`,
    );
  }
  const fontUrl = `/_next/static/media/${fontFiles[0]}`;

  const stylesheets = await filesUnder(".next/static/chunks", (path) => path.endsWith(".css"));
  for (const path of stylesheets) {
    for (const [rule] of (await readFile(path, "utf8")).matchAll(/@font-face\{[^}]*\}/gu)) {
      if (/font-style:italic/u.test(rule)) {
        throw new Error(`@font-face italique dans ${path} : le site n'emploie pas d'italique.`);
      }
    }
  }

  const fontPreloads = (html) =>
    [...html.matchAll(/<link\b[^>]*>/giu)]
      .map(([tag]) => tag)
      .filter((tag) => /\srel="preload"/iu.test(tag) && /\sas="font"/iu.test(tag))
      .map((tag) => /\shref="([^"]+)"/iu.exec(tag)?.[1] ?? "");

  for (const path of [".next/server/app/index.html", ".next/server/app/sales/defaut.html"]) {
    const preloads = fontPreloads(await readFile(path, "utf8"));
    if (preloads.length !== 1 || preloads[0] !== fontUrl) {
      throw new Error(
        `${path} doit précharger la police une fois (${fontUrl}), trouvé : ${JSON.stringify(preloads)}.`,
      );
    }
  }
}

async function checkSourceLineLimits() {
  const today = new Date().toISOString().slice(0, 10);
  const files = await filesUnder("src", (path) => /\.(?:ts|tsx)$/u.test(path));
  for (const path of files) {
    const normalized = path.split("\\").join("/");
    if (/\.(?:test|spec)\.(?:ts|tsx)$/u.test(normalized)) continue;
    const lines = (await readFile(path, "utf8")).split(/\r?\n/u).length;
    if (lines <= MAX_BUSINESS_MODULE_LINES) continue;
    const exceptionUntil = LINE_LIMIT_EXCEPTIONS[normalized];
    if (exceptionUntil && today <= exceptionUntil) continue;
    throw new Error(
      exceptionUntil
        ? `Exception de longueur expirée le ${exceptionUntil} pour ${normalized} (${lines} lignes > ${MAX_BUSINESS_MODULE_LINES}) : découpez le fichier.`
        : `Fichier source trop long: ${normalized} (${lines} lignes > ${MAX_BUSINESS_MODULE_LINES}) : découpez-le ou ajoutez une exception datée justifiée.`,
    );
  }
}

async function clientJavaScriptBytesForRoute({ manifest, routeKey, entryKey }) {
  const source = await readFile(manifest, "utf8");
  const context = { globalThis: {} };
  runInNewContext(source, context);
  const routeManifest = context.globalThis.__RSC_MANIFEST?.[routeKey];
  const files = routeManifest?.entryJSFiles?.[entryKey];
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`Manifest client absent ou vide pour ${routeKey} (${manifest}).`);
  }
  const sizes = await Promise.all(
    [...new Set(files)].map(async (path) => (await stat(join(".next", path))).size),
  );
  return sizes.reduce((sum, bytes) => sum + bytes, 0);
}

async function resolveHtmlPath({ html, htmlDirectory }) {
  if (html) return html;
  const pages = (await readdir(htmlDirectory)).filter((name) => name.endsWith(".html")).sort();
  if (pages.length === 0) throw new Error(`Aucune page HTML préfabriquée dans ${htmlDirectory}.`);
  return join(htmlDirectory, pages[0]);
}

/** Somme des fichiers .js que le HTML d'une page demande au navigateur d'exécuter. */
async function htmlReferencedJavaScriptBytes(htmlPath) {
  const html = await readFile(htmlPath, "utf8");
  const files = new Set();
  for (const [tag] of html.matchAll(/<script\b[^>]*>/giu)) {
    if (/\snomodule(?:[\s=>]|$)/iu.test(tag)) continue;
    const source = /\ssrc="([^"]+)"/iu.exec(tag)?.[1];
    const file = source && /\/_next\/(static\/[^?"#]+\.js)(?:[?#]|$)/u.exec(source)?.[1];
    if (file) files.add(decodeURIComponent(file));
  }
  if (files.size === 0) {
    throw new Error(`Aucun <script src> de /_next/static trouvé dans ${htmlPath}.`);
  }
  const sizes = await Promise.all(
    [...files].map(async (file) => (await stat(join(".next", file))).size),
  );
  return sizes.reduce((sum, bytes) => sum + bytes, 0);
}

/**
 * Vrai pour le chunk qui embarque mapbox-gl : celui qui porte la bannière de licence de la
 * bibliothèque (« Mapbox GL JS »), jamais un chunk qui cite seulement le mot « mapbox ».
 */
async function isMapboxChunk(path) {
  return (await readFile(path, "utf8")).includes("Mapbox GL JS");
}

async function filesUnder(directory, predicate) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return filesUnder(path, predicate);
      return predicate(path) ? [path] : [];
    }),
  );
  return nested.flat();
}
