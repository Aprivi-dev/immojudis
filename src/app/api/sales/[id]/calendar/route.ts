import { NextResponse } from "next/server";
import { PublicApiError } from "@/lib/api-errors";
import { apiRouteError, createApiRequestContext, withApiHeaders } from "@/lib/api-observability";
import { SALE_ID_PATTERN } from "@/lib/public-sale-summary";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { buildSaleCalendarFile, type SaleCalendarRow } from "@/lib/sale-calendar";
import { resolveSiteOrigin } from "@/lib/site-url";
import { createPublicSupabaseClient } from "@/lib/supabase-public.server";

/**
 * One minute in the CDN. It was 300 s, as long as the public page of the sale
 * (`PUBLIC_SALE_REVALIDATE_SECONDS`), while the plan was to purge this response when a sale is
 * withdrawn. Purging a CDN response by tag needs `invalidateByTag` of `@vercel/functions`, which is not
 * a dependency of the repository: the lifetime is bounded instead, so that a withdrawn or postponed
 * hearing leaves the export within a minute (plus 60 s of `stale-while-revalidate`) of the
 * invalidation of its page. See docs/runbooks/catalogue-visibility-projection.md.
 */
const CALENDAR_CACHE_SECONDS = 60;

type RpcError = { code?: string; message?: string } | null;

function isMissingFunction(error: RpcError): boolean {
  return (
    error?.code === "PGRST202" ||
    error?.code === "42883" ||
    /get_public_sale_calendar_event/.test(error?.message ?? "")
  );
}

/**
 * « Ajouter à mon agenda » : the `.ics` file of the hearing of a sale, for everyone (no account).
 *
 * It reads the sale with the anonymous key, through a database function that returns only what a
 * signed-out visitor may see (date, court, kind of property, city) and that refuses a date that
 * is postponed, in conflict, unverified or without a usable day. The property address, which is
 * reserved to signed-in accounts, is never part of the file. The route is not indexed: it sits
 * under `/api/` (disallowed in robots.txt), is absent from the sitemaps and answers
 * `X-Robots-Tag: noindex`.
 *
 * The export follows the public page of the sale, nothing more: the date comes from the public
 * database function above, which does not read the AI review projections
 * (`v_auction_ai_review_projection_read_model`, served by `/api/sales/ai-review` to signed-in
 * accounts only). A date the review blocks on the signed-in page can therefore still be exported
 * as long as the public page shows it. This is why the button says the date comes from the
 * listing and must be checked with the lawyer; no server-side indicator of the review state
 * exists for an anonymous request.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestContext = createApiRequestContext(request, "sale-calendar");
  try {
    await enforceIpRateLimit({
      request,
      bucketKey: "sales.calendar",
      ...RATE_LIMIT_POLICIES.publicIp,
    });
    const { id } = await context.params;
    if (!SALE_ID_PATTERN.test(id)) throw new PublicApiError("Vente introuvable.", 404);

    const client = createPublicSupabaseClient();
    if (!client) throw new Error("Base de données non configurée.");
    const { data, error } = await client.rpc("get_public_sale_calendar_event", {
      p_sale_id: id.toLowerCase(),
    });
    if (error) {
      // The migration is not deployed yet: no export rather than a guess from other columns.
      if (isMissingFunction(error)) throw new Error("Calendrier non configuré.");
      throw error;
    }
    const row = (Array.isArray(data) ? data[0] : data) as SaleCalendarRow | null | undefined;
    if (!row) throw new PublicApiError("Vente introuvable.", 404);

    // Never derived from the request: the answer is kept by shared caches.
    const origin = resolveSiteOrigin(process.env, "http://localhost:3000")!;
    const file = buildSaleCalendarFile(row, { origin });
    if (!file) {
      throw new PublicApiError(
        "La date de cette audience n’est pas confirmée (report, information contradictoire ou source unique) : nous ne l’ajoutons pas à votre agenda. Vérifiez-la auprès de l’avocat poursuivant ou du greffe.",
        409,
      );
    }

    return withApiHeaders(
      new NextResponse(file.body, {
        headers: {
          "content-type": "text/calendar; charset=utf-8",
          "content-disposition": `attachment; filename="${file.filename}"`,
          "cache-control": `public, s-maxage=${CALENDAR_CACHE_SECONDS}, stale-while-revalidate=60`,
          "x-robots-tag": "noindex, nofollow",
        },
      }),
      requestContext,
      // The file is kept by shared caches and served to other visitors: it must not carry the
      // request id of the first request (it stays in the logs).
      { echoRequestId: false },
    );
  } catch (error) {
    const response = apiRouteError(error, request, "sale-calendar", {
      fallbackMessage: "Export vers l’agenda indisponible.",
    });
    response.headers.set("x-robots-tag", "noindex, nofollow");
    return response;
  }
}
