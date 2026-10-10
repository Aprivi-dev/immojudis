import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const MAX_CLIENT_CHUNK_BYTES = 1_850_000;
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
const MAX_TOTAL_CLIENT_JS_BYTES = 5_200_000;
const MAX_LANDING_IMAGE_BYTES = 350_000;
// New homepage: lossless panorama for large screens plus editorial photography.
const MAX_PUBLIC_MEDIA_BYTES = 5_000_000;
const HOMEPAGE_IMAGE_BUDGETS = {
  "public/media/landing/cinematic-bordeaux-lossless.webp": 2_300_000,
  "public/media/landing/gallery-townhouse.webp": 460_000,
  "public/media/landing/gallery-land.webp": 460_000,
};
const MAX_BUSINESS_MODULE_LINES = 1_500;

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

const routeBudgets = [
  {
    name: "favorites",
    manifest: ".next/server/app/favoris/page_client-reference-manifest.js",
    routeKey: "/favoris/page",
    entryKey: "[project]/src/app/favoris/page",
    maxBytes: 670_000,
  },
  {
    name: "alerts",
    manifest: ".next/server/app/alertes/page_client-reference-manifest.js",
    routeKey: "/alertes/page",
    entryKey: "[project]/src/app/alertes/page",
    maxBytes: 570_000,
  },
  {
    name: "home",
    manifest: ".next/server/app/page_client-reference-manifest.js",
    routeKey: "/page",
    entryKey: "[project]/src/app/page",
    maxBytes: 555_000,
  },
  {
    name: "sales",
    manifest: ".next/server/app/sales/page_client-reference-manifest.js",
    routeKey: "/sales/page",
    entryKey: "[project]/src/app/sales/page",
    maxBytes: 750_000,
  },
  {
    name: "sale-detail",
    manifest: ".next/server/app/sales/[id]/page_client-reference-manifest.js",
    routeKey: "/sales/[id]/page",
    entryKey: "[project]/src/app/sales/[id]/page",
    maxBytes: 630_000,
  },
  {
    name: "tribunals",
    manifest: ".next/server/app/tribunaux/page_client-reference-manifest.js",
    routeKey: "/tribunaux/page",
    entryKey: "[project]/src/app/tribunaux/page",
    maxBytes: 640_000,
  },
  {
    name: "example",
    manifest: ".next/server/app/annonce-exemple/page_client-reference-manifest.js",
    routeKey: "/annonce-exemple/page",
    entryKey: "[project]/src/app/annonce-exemple/page",
    maxBytes: 650_000,
  },
  {
    name: "pricing",
    manifest: ".next/server/app/offres/page_client-reference-manifest.js",
    routeKey: "/offres/page",
    entryKey: "[project]/src/app/offres/page",
    maxBytes: 525_000,
  },
  // Administration: one page per view (P3-11). Measured 470-538 KB each, against
  // 566,921 bytes for every view before the split.
  {
    name: "admin-home",
    manifest: ".next/server/app/admin/page_client-reference-manifest.js",
    routeKey: "/admin/page",
    entryKey: "[project]/src/app/admin/page",
    maxBytes: 540_000,
  },
  {
    name: "admin-operations",
    manifest: ".next/server/app/admin/operations/page_client-reference-manifest.js",
    routeKey: "/admin/operations/page",
    entryKey: "[project]/src/app/admin/operations/page",
    maxBytes: 565_000,
  },
  {
    name: "admin-agent",
    manifest: ".next/server/app/admin/agent-ia/page_client-reference-manifest.js",
    routeKey: "/admin/agent-ia/page",
    entryKey: "[project]/src/app/admin/agent-ia/page",
    maxBytes: 500_000,
  },
  {
    name: "admin-publications",
    manifest: ".next/server/app/admin/publications/page_client-reference-manifest.js",
    routeKey: "/admin/publications/page",
    entryKey: "[project]/src/app/admin/publications/page",
    maxBytes: 545_000,
  },
  {
    name: "admin-clients",
    manifest: ".next/server/app/admin/clients/page_client-reference-manifest.js",
    routeKey: "/admin/clients/page",
    entryKey: "[project]/src/app/admin/clients/page",
    maxBytes: 545_000,
  },
  {
    name: "admin-lawyers",
    manifest: ".next/server/app/admin/lawyers/page_client-reference-manifest.js",
    routeKey: "/admin/lawyers/page",
    entryKey: "[project]/src/app/admin/lawyers/page",
    maxBytes: 565_000,
  },
  {
    name: "admin-compliance",
    manifest: ".next/server/app/admin/compliance/page_client-reference-manifest.js",
    routeKey: "/admin/compliance/page",
    entryKey: "[project]/src/app/admin/compliance/page",
    maxBytes: 555_000,
  },
];

const requiredHtml = [[".next/server/app/index.html", "Les enchères immobilières"]];

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
const chunkSizes = await Promise.all(chunks.map(async (path) => [path, (await stat(path)).size]));
const totalClientBytes = chunkSizes.reduce((sum, [, size]) => sum + size, 0);
const [largestChunk, largestChunkBytes] = chunkSizes.sort(
  (left, right) => right[1] - left[1],
)[0] ?? ["none", 0];

if (largestChunkBytes > MAX_CLIENT_CHUNK_BYTES) {
  throw new Error(
    `Chunk client trop lourd: ${largestChunk} (${largestChunkBytes} octets > ${MAX_CLIENT_CHUNK_BYTES}).`,
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
    landingWebpCount: landingImages.length,
    largestBusinessModuleLines: Math.max(...Object.values(businessModuleLines)),
    publicMediaBytes,
    routeClientBytes,
    totalClientBytes,
  }),
);

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
