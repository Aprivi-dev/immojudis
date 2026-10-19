import { revalidatePath, revalidateTag } from "next/cache";
import { after, NextResponse } from "next/server";
import { z } from "zod";
import { cronRequestAuthorized } from "@/lib/cron-auth";
import { PUBLIC_CATALOGUE_CACHE_TAG } from "@/lib/public-catalogue.server";
import { publicSaleCacheTag } from "@/lib/public-sale.server";
import { SALE_ID_PATTERN } from "@/lib/public-sale-summary";
import { resolveRequestId } from "@/lib/request-id";
import { warmSalePages } from "@/lib/sale-page-warmup";
import { SALES_DEFAULT_PATH, SALES_PAGE_VARIANTS_ROUTE, SALES_PATH } from "@/lib/sales-isr";

const MAX_SALES_PER_CALL = 100;

// The warm-up runs in `after()`, inside this budget: 24 pages at 4 at a time and 5 s each take
// 30 s in the worst case (see `MAX_WARMUP_PAGES`), so 60 s leaves a 30 s margin.
export const maxDuration = 60;

const saleIdSchema = z.string().regex(SALE_ID_PATTERN, "Identifiant de vente invalide.");
const bodySchema = z.union([
  z.object({ saleId: saleIdSchema }).strict(),
  z.object({ saleIds: z.array(saleIdSchema).min(1).max(MAX_SALES_PER_CALL) }).strict(),
]);

/**
 * Cache invalidation called by the data pipeline once it has changed a sale (P6-06).
 *
 * `POST /api/pipeline/revalidate-sale` with `Authorization: Bearer $CRON_SECRET` (the secret
 * that already protects the Vercel Cron routes) and a JSON body `{ "saleId": "<uuid>" }`
 * or `{ "saleIds": ["<uuid>", ...] }` (at most 100). For every sale it expires the
 * `sale-<id>` data-cache tag and the cached page `/sales/<id>`: the next visitor triggers
 * a fresh read instead of waiting for the 5-minute revalidation.
 *
 * The call also expires, once per call whatever the number of sales, the catalogue pages: the
 * `public-catalogue` data-cache tag (first page, 5 minutes) and the static page that serves the
 * bare `/sales`. A sale that is withdrawn, cancelled or changed must leave `/sales` as soon as it
 * leaves its own page, not 5 to 10 minutes later. The pipeline must therefore announce those
 * sales too, not only the new ones.
 *
 * Once the response is sent (`after()`), each invalidated page is requested once on the public
 * origin so that it is regenerated before the first visitor (often a crawler) arrives: the sale
 * pages and `/sales` itself (rewritten to the static page expired above). That warm-up never delays
 * nor fails the response (see `warmSalePages`).
 *
 * What this route cannot purge: the CDN copies of `/api/catalogue/preview` and of the `.ics` export
 * (`/api/sales/<id>/calendar`). Purging them by tag needs `invalidateByTag` of `@vercel/functions`,
 * which the repository does not depend on; both routes therefore keep their answer for 60 s only (see
 * `PREVIEW_CDN_MAX_AGE_SECONDS` and `CALENDAR_CACHE_SECONDS`).
 */
export async function POST(request: Request) {
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  const headers = { "cache-control": "no-store", "x-request-id": requestId };

  if (!cronRequestAuthorized(request)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized", code: "AUTH_REQUIRED", requestId },
      { status: 401, headers },
    );
  }

  const payload = bodySchema.safeParse(await readJson(request));
  if (!payload.success) {
    return NextResponse.json(
      {
        ok: false,
        error: `Corps attendu : { "saleId": "<uuid>" } ou { "saleIds": [<uuid>, ...] } (${MAX_SALES_PER_CALL} au plus).`,
        code: "INVALID_REQUEST",
        requestId,
      },
      { status: 400, headers },
    );
  }

  const ids = [
    ...new Set(
      ("saleId" in payload.data ? [payload.data.saleId] : payload.data.saleIds).map((id) =>
        id.toLowerCase(),
      ),
    ),
  ];
  for (const id of ids) {
    // `expire: 0`: no stale copy is served, the next request reads the database.
    revalidateTag(publicSaleCacheTag(id), { expire: 0 });
    revalidatePath(`/sales/${id}`);
  }
  // The catalogue lists the sale whatever its id: once per call, not once per sale.
  revalidateTag(PUBLIC_CATALOGUE_CACHE_TAG, { expire: 0 });
  // The destination of the rewrite, not `/sales`: `revalidatePath` works on the route files, and
  // the proxy (which rewrites `/sales` to this page) does not run for revalidations.
  revalidatePath(SALES_DEFAULT_PATH);
  // Pages 2 et 3 du catalogue (variantes statiques `/sales/defaut/[page]`) : même durée de vie, même
  // retrait d'une vente. Le motif de la route, avec le type « page », les couvre toutes.
  revalidatePath(SALES_PAGE_VARIANTS_ROUTE, "page");
  // One GET per invalidated sale, and one on the public `/sales` (the proxy rewrites it to the static
  // page just expired), after the response: it cannot call this route back.
  after(() => warmSalePages(ids, { requestId, extraPaths: [SALES_PATH] }));

  return NextResponse.json(
    { ok: true, revalidated: ids.map(publicSaleCacheTag), requestId },
    { headers },
  );
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
