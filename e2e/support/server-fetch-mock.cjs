/*
 * Preload of the E2E server only (scripts/start-e2e-server.mjs adds it to NODE_OPTIONS).
 *
 * The E2E build points NEXT_PUBLIC_SUPABASE_URL at https://ci.supabase.co, which does not exist.
 * Playwright's `page.route` only intercepts what the browser sends: the server-side calls of
 * `/sales/<id>` (public summary of the sale, withdrawn sources…) reach the network and fail, and
 * the page answers 500. This preload answers only the reads of a sale page with canned data (the
 * public summary and details, the database verdict on indexing, the withdrawn sources), inside the
 * Node process of `next start`, and lets every other request through untouched.
 *
 * Keep it in step with `readPublicSale` (src/lib/public-sale.server.ts): a read added there and not
 * answered here makes every sale page answer 500 in the E2E build. A Vitest test
 * (src/lib/e2e-server-fetch-mock.test.ts) runs that read against this file and fails if it drifts.
 *
 * Nothing here is bundled: it is never loaded by `next build`, `next dev` or production.
 */

const originalFetch = globalThis.fetch;
const SUPABASE_ORIGIN = "https://ci.supabase.co/";

/** The sale the E2E specs open (e2e/sale-unlock.spec.ts). Its date is always in the future. */
const SALE = {
  id: "11111111-1111-4111-8111-111111111111",
  starting_price_eur: 90000,
  sale_venue_type: "tribunal",
  sale_verification_status: "verified",
  city: "Lyon",
  department: "69",
  property_type: "apartment",
  sale_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  app_surface_m2: 60,
  app_surface_kind: "habitable",
  rooms_count: 3,
  bedrooms_count: 2,
  bathrooms_count: 1,
  tribunal_name: "Tribunal judiciaire de Lyon",
  tribunal_city: "Lyon",
  thumbnail_url: null,
  content_changed_at: null,
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = async function e2eFetch(input, init) {
  const url = typeof input === "string" ? input : (input.url ?? String(input));
  if (!url.startsWith(SUPABASE_ORIGIN)) return originalFetch(input, init);

  const { pathname } = new URL(url);
  if (pathname.endsWith("/rpc/get_public_sale_summary")) {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    return json(body.p_sale_id === SALE.id ? [SALE] : []);
  }
  if (pathname.endsWith("/rpc/get_public_sale_details")) return json([]);
  // The database verdict on indexing (the page reads it for its robots meta): a verified court
  // sale in the future is indexable. A failure here is thrown, not swallowed: it would be a 500.
  if (pathname.endsWith("/rpc/get_public_sale_indexability")) return json(true);
  // The market gap band of the public page: nothing to say (no reliable estimate in the E2E
  // build). An answer is still needed, or the lookup waits for a DNS error.
  if (pathname.endsWith("/rpc/get_public_sale_market_gap_band")) return json(null);
  // No source withdrawn (the default state): without this answer the lookup waits for a DNS error.
  if (pathname.endsWith("/rpc/get_withdrawn_catalogue_sources")) return json([]);
  // Everything else (the catalogue search…) keeps failing as it did before
  // this preload: a server that gets an empty answer would render and hydrate an empty catalogue
  // that the specs, which serve their own results to the browser with page.route, never expect.
  return originalFetch(input, init);
};
