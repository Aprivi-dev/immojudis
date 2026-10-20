import { randomUUID } from "node:crypto";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const DEFAULT_ORIGIN = "https://immojudis.com";
const TIMEOUT_MS = 10_000;
// The static pages (/sitemap.xml) number about twenty; the sales sitemap holds the whole catalogue.
const DEFAULT_MIN_PAGE_URLS = 10;
const DEFAULT_MIN_SALE_URLS = 100;
// Sales tried, in the order of the sitemap, before concluding that the listed sales do not answer.
const SALE_CANDIDATES = 3;

// Request headers on which Next.js varies every App Router response (RSC payload, prefetch, router
// state). The CDN keys them itself (and Next.js adds `_rsc` to those requests): a plain page load
// sends none of them, so they do not split the cache of /sales between visitors.
const NEXT_ROUTER_VARY = new Set([
  "rsc",
  "next-router-state-tree",
  "next-router-prefetch",
  "next-router-segment-prefetch",
  "next-url",
]);

// A well-formed identifier that no sale carries. Searching it never matches a real record.
const UNKNOWN_SALE_PATH = "/sales/00000000-0000-4000-8000-000000000000";

// Static variant of the bare `/sales` (src/lib/sales-isr.ts): internal, never linked nor listed.
const SALES_DEFAULT_PATH = "/sales/defaut";
// The paginated catalogue is rendered on demand: its HTML must still hold the listings.
const MIN_PAGE_LISTING_LINKS = 20;
// Sitemaps read at most, to look for the internal variant (the pages, the articles, the sales files).
const MAX_SITEMAPS_CHECKED = 30;
const SALE_LINK =
  /href=["'](?:https?:\/\/[^"'/]+)?\/sales\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=[?#"'&])/gi;

const checks = [
  { path: "/", kind: "html", canonical: "/" },
  { path: "/sales", kind: "html", canonical: "/sales" },
  { path: "/annonce-exemple", kind: "html", canonical: "/annonce-exemple" },
  { path: "/legal", kind: "html" },
  // Never indexed (its page carries `robots: noindex`), whatever the indexing switch says.
  { path: "/login", kind: "html" },
  { path: "/api/lawyers/directory?department=33", kind: "json" },
  // A sale that does not exist must answer a real 404, not a 200 page that says "not found"
  // (a soft 404 that search engines index).
  { path: UNKNOWN_SALE_PATH, kind: "html", expectedStatus: 404 },
];

/**
 * Which indexing state the deployed site must be in: "open" only when SEO_INDEXING_ENABLED is
 * exactly "true" (same rule as src/lib/seo-indexing.ts), "closed" for anything else, absent
 * included.
 */
export function expectedIndexingState(value) {
  return String(value ?? "").trim() === "true" ? "open" : "closed";
}

export async function checkProductionSmoke({
  origin = DEFAULT_ORIGIN,
  fetchImpl = fetch,
  indexing = expectedIndexingState(process.env.SEO_INDEXING_ENABLED),
  minPageUrls = DEFAULT_MIN_PAGE_URLS,
  minSaleUrls = DEFAULT_MIN_SALE_URLS,
} = {}) {
  if (indexing !== "open" && indexing !== "closed") {
    throw new Error(`État d'indexation attendu invalide : ${indexing} (open ou closed).`);
  }
  const normalizedOrigin = normalizeOrigin(origin);
  const startedAt = Date.now();
  const results = await Promise.all(
    checks.map((check) =>
      runCheck({
        check: withIndexingExpectation(check, indexing),
        origin: normalizedOrigin,
        fetchImpl,
      }),
    ),
  );
  const catalogueResults = await runCatalogueChecks({ origin: normalizedOrigin, fetchImpl });
  const seoResults = await runSeoChecks({
    origin: normalizedOrigin,
    fetchImpl,
    indexing,
    minPageUrls,
    minSaleUrls,
  });

  return {
    ok: true,
    origin: normalizedOrigin,
    indexing,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    checks: [...results, ...catalogueResults, ...seoResults],
  };
}

/**
 * The home page carries no `X-Robots-Tag` once indexing is open, and `noindex` while it is closed
 * (src/proxy.ts). `/login` is noindex in both states (its own `robots` metadata).
 */
function withIndexingExpectation(check, indexing) {
  if (check.path === "/") {
    return { ...check, robotsTag: indexing === "open" ? "absent" : "noindex" };
  }
  if (check.path === "/login") return { ...check, robotsMeta: "noindex" };
  return check;
}

async function runCheck({ check, origin, fetchImpl }) {
  const requestId = `smoke-${randomUUID()}`;
  const url = new URL(check.path, origin);
  const startedAt = Date.now();
  const response = await fetchImpl(url, {
    headers: {
      accept: check.kind === "json" ? "application/json" : "text/html",
      "user-agent": "immojudis-production-smoke/1.0",
      "x-request-id": requestId,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const expectedStatus = check.expectedStatus ?? 200;
  if (response.status !== expectedStatus) {
    throw new Error(`${check.path}: statut HTTP ${response.status} au lieu de ${expectedStatus}.`);
  }

  const responseRequestId = response.headers.get("x-request-id");
  if (!responseRequestId || !REQUEST_ID_PATTERN.test(responseRequestId)) {
    throw new Error(`${check.path}: en-tête x-request-id absent ou invalide.`);
  }
  if (responseRequestId !== requestId) {
    throw new Error(`${check.path}: la corrélation x-request-id n'est pas préservée.`);
  }

  if (check.robotsTag) assertRobotsTagHeader(check.path, response, check.robotsTag);

  if (expectedStatus !== 200) {
    await response.body?.cancel();
    return {
      path: check.path,
      status: response.status,
      requestId: responseRequestId,
      durationMs: Date.now() - startedAt,
    };
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (check.kind === "json") {
    if (!contentType.includes("application/json")) {
      throw new Error(`${check.path}: réponse JSON attendue, reçu ${contentType || "inconnu"}.`);
    }
    const body = await response.json();
    if (!body || !Array.isArray(body.lawyers)) {
      throw new Error(`${check.path}: contrat de l'annuaire invalide.`);
    }
  } else {
    if (!contentType.includes("text/html")) {
      throw new Error(`${check.path}: réponse HTML attendue, reçu ${contentType || "inconnu"}.`);
    }
    const body = await response.text();
    if (!body.toLowerCase().includes("immojudis")) {
      throw new Error(`${check.path}: identité Immojudis absente du document.`);
    }
    if (check.canonical) {
      const canonical = new URL(check.canonical, origin).href;
      const canonicalHref = canonicalOf(body);
      if (!canonicalHref || new URL(canonicalHref, origin).href !== canonical) {
        throw new Error(`${check.path}: URL canonique ${canonical} absente.`);
      }
    }
    if (check.robotsMeta === "noindex" && !/noindex/i.test(robotsMetaOf(body) ?? "")) {
      throw new Error(`${check.path}: balise robots noindex absente.`);
    }
  }

  return {
    path: check.path,
    status: response.status,
    requestId: responseRequestId,
    durationMs: Date.now() - startedAt,
  };
}

/** `href` of the canonical link of an HTML document, or null. */
function canonicalOf(body) {
  const tag = body.match(/<link\b[^>]*>/gi)?.find((link) => /\brel=["']canonical["']/i.test(link));
  return tag?.match(/\bhref=["']([^"']+)["']/i)?.[1] ?? null;
}

/** `content` of `<meta name="robots">`, or null. */
function robotsMetaOf(body) {
  const tag = body.match(/<meta\b[^>]*>/gi)?.find((meta) => /\bname=["']robots["']/i.test(meta));
  return tag?.match(/\bcontent=["']([^"']*)["']/i)?.[1] ?? null;
}

function assertRobotsTagHeader(path, response, expected) {
  const value = response.headers.get("x-robots-tag");
  if (expected === "absent" && value) {
    throw new Error(
      `${path}: en-tête X-Robots-Tag « ${value} » présent alors que l'indexation est ouverte.`,
    );
  }
  if (expected === "noindex" && !/noindex/i.test(value ?? "")) {
    throw new Error(
      `${path}: en-tête X-Robots-Tag noindex absent alors que l'indexation est fermée.`,
    );
  }
}

/** Fetches a text resource that the proxy does not stamp with a request id (robots, sitemaps). */
async function fetchText(path, { origin, fetchImpl }) {
  const startedAt = Date.now();
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new Error(`${path}: adresse hors de l'origine ${origin}.`);
  const response = await fetchImpl(url, {
    headers: { accept: "*/*", "user-agent": "immojudis-production-smoke/1.0" },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status !== 200) {
    await response.body?.cancel?.();
    throw new Error(`${url.pathname}: statut HTTP ${response.status} au lieu de 200.`);
  }
  return { response, body: await response.text(), durationMs: Date.now() - startedAt, url };
}

/** Distinct sale identifiers linked (`/sales/<uuid>`) from an HTML document. */
function saleLinkIds(body) {
  return new Set(Array.from(body.matchAll(SALE_LINK), (match) => match[1].toLowerCase()));
}

async function fetchCatalogue(
  path,
  { origin, fetchImpl, accept = "text/html", redirect = "follow" },
) {
  const startedAt = Date.now();
  const response = await fetchImpl(new URL(path, origin), {
    headers: { accept, "user-agent": "immojudis-production-smoke/1.0" },
    redirect,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { response, startedAt };
}

/**
 * The public catalogue and its caches (docs/runbooks/catalogue-visibility-projection.md):
 *  - `/sales` is served from the CDN: the second of two successive requests is `x-vercel-cache: HIT`,
 *    and neither carries `set-cookie` (a cookie makes a response uncacheable) nor, on the cached one,
 *    a `Vary` beyond the router headers Next.js always sets (`NEXT_ROUTER_VARY`); its HTML lists
 *    sales (`/sales/<uuid>`);
 *  - the static variant `/sales/defaut` is `noindex`;
 *  - `/sales?page=2` is rendered on the server: at least 20 listings in the HTML;
 *  - `/api/catalogue/preview` answers with a public `cache-control`.
 */
async function runCatalogueChecks({ origin, fetchImpl }) {
  const results = [];

  // Two successive requests: the first one fills the cache, the second one must hit it.
  const first = await fetchCatalogue("/sales", { origin, fetchImpl });
  if (first.response.status !== 200) {
    throw new Error(`/sales: statut HTTP ${first.response.status} au lieu de 200.`);
  }
  const firstBody = await first.response.text();
  assertNoCookie("/sales", first.response);
  const second = await fetchCatalogue("/sales", { origin, fetchImpl });
  if (second.response.status !== 200) {
    throw new Error(`/sales (2e requête): statut HTTP ${second.response.status} au lieu de 200.`);
  }
  await second.response.body?.cancel?.();
  const cacheStatus = second.response.headers.get("x-vercel-cache");
  if (!/^HIT$/i.test(cacheStatus ?? "")) {
    throw new Error(
      `/sales: la 2e requête successive n'est pas servie par le cache (x-vercel-cache: ${cacheStatus ?? "absent"} au lieu de HIT).`,
    );
  }
  assertNoCookie("/sales", second.response);
  const vary = second.response.headers.get("vary");
  const foreignVary = (vary ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name && !NEXT_ROUTER_VARY.has(name));
  if (foreignVary.length > 0) {
    throw new Error(`/sales: en-tête Vary « ${vary} » sur la réponse servie par le cache.`);
  }
  const listed = saleLinkIds(firstBody).size;
  if (listed === 0) {
    throw new Error("/sales: aucun lien /sales/<identifiant> dans le HTML.");
  }
  results.push({
    path: "/sales (cache)",
    status: 200,
    cache: "HIT",
    sales: listed,
    durationMs: Date.now() - first.startedAt,
  });

  // The internal static variant must never be indexed. A direct request is redirected to `/sales`
  // by the proxy, which stamps the header on the redirect itself: read it without following.
  const internal = await fetchCatalogue(SALES_DEFAULT_PATH, {
    origin,
    fetchImpl,
    redirect: "manual",
  });
  await internal.response.body?.cancel?.();
  if (internal.response.status >= 400) {
    throw new Error(`${SALES_DEFAULT_PATH}: statut HTTP ${internal.response.status}.`);
  }
  if (!/noindex/i.test(internal.response.headers.get("x-robots-tag") ?? "")) {
    throw new Error(`${SALES_DEFAULT_PATH}: en-tête X-Robots-Tag noindex absent.`);
  }
  results.push({
    path: SALES_DEFAULT_PATH,
    status: internal.response.status,
    durationMs: Date.now() - internal.startedAt,
  });

  // The paginated catalogue is rendered at request time, with its listings in the first HTML.
  const paginated = await fetchCatalogue("/sales?page=2", { origin, fetchImpl });
  if (paginated.response.status !== 200) {
    throw new Error(`/sales?page=2: statut HTTP ${paginated.response.status} au lieu de 200.`);
  }
  const listings = saleLinkIds(await paginated.response.text()).size;
  if (listings < MIN_PAGE_LISTING_LINKS) {
    throw new Error(
      `/sales?page=2: ${listings} lien(s) de fiche dans le HTML au lieu d'au moins ${MIN_PAGE_LISTING_LINKS}.`,
    );
  }
  results.push({
    path: "/sales?page=2",
    status: 200,
    sales: listings,
    durationMs: Date.now() - paginated.startedAt,
  });

  // The search API of the browser is public and cacheable.
  const preview = await fetchCatalogue("/api/catalogue/preview", {
    origin,
    fetchImpl,
    accept: "application/json",
  });
  if (preview.response.status !== 200) {
    throw new Error(
      `/api/catalogue/preview: statut HTTP ${preview.response.status} au lieu de 200.`,
    );
  }
  const cacheControl = preview.response.headers.get("cache-control") ?? "";
  if (!/(^|[\s,])public(?=[\s,]|$)/i.test(cacheControl) || /no-store|private/i.test(cacheControl)) {
    throw new Error(
      `/api/catalogue/preview: cache-control « ${cacheControl || "absent"} » au lieu d'un cache public.`,
    );
  }
  const previewBody = await preview.response.json();
  if (!previewBody || !Array.isArray(previewBody.items)) {
    throw new Error("/api/catalogue/preview: contrat de la réponse invalide.");
  }
  results.push({
    path: "/api/catalogue/preview",
    status: 200,
    cacheControl,
    durationMs: Date.now() - preview.startedAt,
  });
  return results;
}

function assertNoCookie(path, response) {
  const cookie = response.headers.get("set-cookie");
  if (cookie) {
    throw new Error(`${path}: en-tête Set-Cookie présent (la page ne serait pas mise en cache).`);
  }
}

function sitemapUrls(xml) {
  return Array.from(xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi), (match) =>
    match[1].replaceAll("&amp;", "&"),
  );
}

function jsonLdBlocks(body) {
  return Array.from(
    body.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi),
    (match) => match[1],
  );
}

/**
 * Search-engine checks: robots.txt, the sitemaps, a real sale taken from the sitemap. What is
 * checked depends on the expected indexing state (SEO_INDEXING_ENABLED of the deployed site).
 */
async function runSeoChecks({ origin, fetchImpl, indexing, minPageUrls, minSaleUrls }) {
  const results = [];
  const robots = await fetchText("/robots.txt", { origin, fetchImpl });
  const sitemapLines = robots.body.match(/^\s*sitemap:\s*\S+/gim) ?? [];
  const blocksEverything = /^\s*disallow:\s*\/\s*$/im.test(robots.body);

  if (indexing === "closed") {
    // Closed: the crawler may read the pages (and their noindex), but no sitemap is advertised.
    if (sitemapLines.length > 0) {
      throw new Error(
        "/robots.txt: des lignes Sitemap: sont publiées alors que l'indexation est fermée.",
      );
    }
    results.push({ path: "/robots.txt", status: 200, durationMs: robots.durationMs });
    return results;
  }

  if (sitemapLines.length === 0) {
    throw new Error("/robots.txt: aucune ligne Sitemap: alors que l'indexation est ouverte.");
  }
  if (blocksEverything) {
    throw new Error("/robots.txt: « Disallow: / » alors que l'indexation est ouverte.");
  }
  results.push({ path: "/robots.txt", status: 200, durationMs: robots.durationMs });

  const listed = sitemapLines.map((line) => line.replace(/^\s*sitemap:\s*/i, "").trim());
  const pagesSitemap = new URL("/sitemap.xml", origin).href;
  if (!listed.includes(pagesSitemap)) {
    throw new Error(`/robots.txt: ${pagesSitemap} n'est pas listé.`);
  }

  // The static pages sitemap and the first sales file must carry enough URLs.
  const pages = await fetchText("/sitemap.xml", { origin, fetchImpl });
  const pageUrls = sitemapUrls(pages.body);
  if (pageUrls.length < minPageUrls) {
    throw new Error(`/sitemap.xml: ${pageUrls.length} URL au lieu d'au moins ${minPageUrls}.`);
  }
  results.push({
    path: "/sitemap.xml",
    status: 200,
    urls: pageUrls.length,
    durationMs: pages.durationMs,
  });

  const salesSitemap = listed.find((url) => /\/sales\/sitemap\/\d+\.xml$/.test(url));
  if (!salesSitemap) {
    throw new Error("/robots.txt: aucun sitemap des fiches (/sales/sitemap/N.xml).");
  }
  const sales = await fetchText(salesSitemap, { origin, fetchImpl });
  const saleUrls = sitemapUrls(sales.body);
  if (saleUrls.length < minSaleUrls) {
    throw new Error(
      `${sales.url.pathname}: ${saleUrls.length} URL au lieu d'au moins ${minSaleUrls}.`,
    );
  }
  results.push({
    path: sales.url.pathname,
    status: 200,
    urls: saleUrls.length,
    durationMs: sales.durationMs,
  });

  // No sitemap may list the internal static variant of /sales.
  assertNoInternalVariant("/sitemap.xml", pageUrls);
  assertNoInternalVariant(sales.url.pathname, saleUrls);
  const checked = new Set([pagesSitemap, new URL(salesSitemap, origin).href]);
  for (const sitemap of listed.slice(0, MAX_SITEMAPS_CHECKED)) {
    if (checked.has(sitemap)) continue;
    checked.add(sitemap);
    const other = await fetchText(sitemap, { origin, fetchImpl });
    assertNoInternalVariant(other.url.pathname, sitemapUrls(other.body));
  }
  results.push({ path: "sitemaps", status: 200, count: checked.size, durationMs: 0 });

  results.push(
    await checkListedSale({ saleUrls: saleUrls.slice(0, SALE_CANDIDATES), origin, fetchImpl }),
  );
  return results;
}

function assertNoInternalVariant(sitemapPath, urls) {
  const found = urls.find((url) => {
    try {
      const { pathname } = new URL(url);
      return pathname === SALES_DEFAULT_PATH || pathname.startsWith(`${SALES_DEFAULT_PATH}/`);
    } catch {
      return false;
    }
  });
  if (found) throw new Error(`${sitemapPath}: la variante interne ${found} est listée au sitemap.`);
}

/** A sale taken from the sitemap must be a real, indexable page that describes itself. */
async function checkListedSale({ saleUrls, origin, fetchImpl }) {
  const startedAt = Date.now();
  let lastProblem = "aucune fiche dans le sitemap";
  for (const saleUrl of saleUrls) {
    const url = new URL(saleUrl);
    if (url.origin !== origin) {
      throw new Error(`${saleUrl}: fiche listée hors de l'origine ${origin}.`);
    }
    const response = await fetchImpl(url, {
      headers: { accept: "text/html", "user-agent": "immojudis-production-smoke/1.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 404) {
      // The sale may have expired between the sitemap cache and now: try the next one.
      await response.body?.cancel?.();
      lastProblem = `${url.pathname}: statut HTTP 404`;
      continue;
    }
    if (response.status !== 200) {
      throw new Error(`${url.pathname}: statut HTTP ${response.status} au lieu de 200.`);
    }
    const header = response.headers.get("x-robots-tag");
    if (header && /noindex/i.test(header)) {
      throw new Error(
        `${url.pathname}: en-tête X-Robots-Tag « ${header} » sur une fiche listée au sitemap.`,
      );
    }
    const body = await response.text();
    const meta = robotsMetaOf(body);
    if (meta && /noindex/i.test(meta)) {
      throw new Error(`${url.pathname}: fiche listée au sitemap mais en noindex (« ${meta} »).`);
    }
    const canonicalHref = canonicalOf(body);
    if (!canonicalHref || new URL(canonicalHref, origin).href !== url.href) {
      throw new Error(
        `${url.pathname}: URL canonique ${url.href} absente (reçu ${canonicalHref ?? "aucune"}).`,
      );
    }
    const blocks = jsonLdBlocks(body);
    if (blocks.length === 0) {
      throw new Error(`${url.pathname}: données structurées JSON-LD absentes.`);
    }
    const graphTypes = [];
    for (const block of blocks) {
      let data;
      try {
        data = JSON.parse(block);
      } catch {
        throw new Error(`${url.pathname}: JSON-LD invalide (JSON illisible).`);
      }
      if (!/schema\.org/.test(String(data?.["@context"] ?? ""))) {
        throw new Error(`${url.pathname}: JSON-LD sans @context schema.org.`);
      }
      for (const node of data["@graph"] ?? [data]) graphTypes.push(node?.["@type"]);
    }
    if (!graphTypes.includes("RealEstateListing")) {
      throw new Error(`${url.pathname}: JSON-LD sans RealEstateListing.`);
    }
    return { path: url.pathname, status: 200, durationMs: Date.now() - startedAt };
  }
  throw new Error(`Aucune fiche du sitemap n'a répondu 200 (${lastProblem}).`);
}

function normalizeOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("L'origine de production doit utiliser HTTPS.");
  }
  return url.origin;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const option = (name) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const origin = option("--origin") ?? process.env.IMMOJUDIS_SMOKE_ORIGIN;
  // Expected indexing state: --indexing open|closed, else the SEO_INDEXING_ENABLED variable
  // (exactly "true" = open; absent or anything else = closed, like the site itself).
  const indexing = option("--indexing") ?? expectedIndexingState(process.env.SEO_INDEXING_ENABLED);
  const minSaleUrls = Number(option("--min-sale-urls") ?? DEFAULT_MIN_SALE_URLS);

  try {
    const report = await checkProductionSmoke({
      origin: origin || DEFAULT_ORIGIN,
      indexing,
      minSaleUrls,
    });
    console.info(JSON.stringify(report));
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
}
