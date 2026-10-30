import "server-only";
import { revalidatePath, revalidateTag } from "next/cache";
import { after, NextResponse } from "next/server";
import { z } from "zod";
import { cronRequestAuthorized } from "@/lib/cron-auth";
import { PUBLIC_CATALOGUE_CACHE_TAG } from "@/lib/public-catalogue.server";
import { publicSaleCacheTag } from "@/lib/public-sale.server";
import { SALE_ID_PATTERN } from "@/lib/public-sale-summary";
import { PUBLIC_TRIBUNAL_ACTIVITY_CACHE_TAG } from "@/lib/public-tribunal-activity.server";
import { resolveRequestId } from "@/lib/request-id";
import { warmSalePages } from "@/lib/sale-page-warmup";
import {
  SALES_DEFAULT_PATH,
  SALES_ISR_PAGES,
  SALES_PAGE_VARIANTS_ROUTE,
  SALES_PATH,
} from "@/lib/sales-isr";
import { TRIBUNAL_PAGES_PATH } from "@/lib/tribunal-pages";
import { TRIBUNAL_SALES_CACHE_TAG } from "@/lib/tribunal-pages.server";
import { HEARINGS_PATH } from "@/lib/upcoming-hearings";
import { HEARINGS_CACHE_TAG } from "@/lib/upcoming-hearings.server";

const MAX_SALES_PER_CALL = 100;

// The warm-up runs in `after()`, inside this budget: four list pages at 4 at a time and 5 s each.
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
 * The call also expires, once per call whatever the number of sales, the pages that list sales
 * without being their own page: the tribunal pages (`/tribunaux/<slug>`, 1 h data cache tagged
 * `tribunal-pages`), the court directory (`/tribunaux`) with the court activity it reads (data cache
 * tagged `public-tribunal-activity`, whose counts change with the sales) and the upcoming hearings
 * (`/audiences-a-venir`, tagged `upcoming-hearings`).
 * A withdrawn sale must leave them as soon as it leaves its own page. And the catalogue pages: the
 * `public-catalogue` data-cache tag (first page, 5 minutes) and the static page that serves the
 * bare `/sales`. A sale that is withdrawn, cancelled or changed must leave `/sales` as soon as it
 * leaves its own page, not 5 to 10 minutes later. The pipeline must therefore announce those
 * sales too, not only the new ones.
 *
 * Once the response is sent (`after()`), the list pages most visited by people are requested once on
 * the public origin so that they are regenerated before the first visitor arrives: `/sales` itself and
 * its pages 2 and 3 (rewritten to the static pages expired above) and the upcoming hearings. The pages
 * of the sales and of the courts are left to their first visitor (often a crawler): warming them after
 * each of the ~50 daily pipeline runs regenerated up to 32 pages per call that nobody had asked for, and
 * exceeded the ISR writes and active CPU of the Vercel plan (30/10/2026). That warm-up never delays nor
 * fails the response (see `warmSalePages`).
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
  // Pages tribunal (`/tribunaux/[slug]`, route dynamique : type « page ») et audiences à venir : leurs
  // lectures sont mises en cache une heure ou quinze minutes, une vente retirée n'y resterait pas.
  revalidateTag(TRIBUNAL_SALES_CACHE_TAG, { expire: 0 });
  revalidateTag(HEARINGS_CACHE_TAG, { expire: 0 });
  revalidatePath("/tribunaux/[slug]", "page");
  revalidatePath("/audiences-a-venir");
  // L'activité des tribunaux (comptes de ventes à venir, une heure de cache) alimente `/tribunaux`, les
  // pages tribunal et `/audiences-a-venir` : sans cette étiquette, une vente retirée y restait comptée
  // jusqu'à une heure après la purge des pages.
  revalidateTag(PUBLIC_TRIBUNAL_ACTIVITY_CACHE_TAG, { expire: 0 });
  revalidatePath(TRIBUNAL_PAGES_PATH);
  // One GET on the public `/sales` and its static pages 2 and 3 (the proxy rewrites them to the
  // variants just expired) and on the hearings, after the response: it cannot call this route back.
  after(async () =>
    warmSalePages([], {
      requestId,
      extraPaths: [
        SALES_PATH,
        ...SALES_ISR_PAGES.map((page) => `${SALES_PATH}?page=${page}`),
        HEARINGS_PATH,
      ],
    }),
  );

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
