import { NextResponse } from "next/server";
import { PublicApiError } from "@/lib/api-errors";
import { apiRouteError, createApiRequestContext, withApiHeaders } from "@/lib/api-observability";
import { SALE_ID_PATTERN } from "@/lib/public-sale-summary";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { buildSaleCalendarFile, type SaleCalendarRow } from "@/lib/sale-calendar";
import { resolveSiteOrigin } from "@/lib/site-url";
import { createPublicSupabaseClient } from "@/lib/supabase-public.server";

/** Same freshness as the public page of the sale (`PUBLIC_SALE_REVALIDATE_SECONDS`). */
const CALENDAR_CACHE_SECONDS = 300;

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
        "La date de cette audience n’est pas assez sûre pour être ajoutée à un agenda. Consultez la fiche de la vente.",
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
    );
  } catch (error) {
    const response = apiRouteError(error, request, "sale-calendar", {
      fallbackMessage: "Export vers l’agenda indisponible.",
    });
    response.headers.set("x-robots-tag", "noindex, nofollow");
    return response;
  }
}
