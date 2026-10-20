import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { PublicApiError } from "@/lib/api-errors";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import { assertFeatureEntitlementVia } from "@/lib/property-reports";
import {
  TribunalCourtUnresolvedError,
  tribunalListingStatisticsQuerySchema,
  tribunalListingStatisticsResponseSchema,
} from "@/lib/tribunal-listing-statistics";
import { getTribunalListingStatistics } from "@/lib/tribunal-listing-statistics-repository";

export async function GET(request: Request) {
  const context = createApiRequestContext(request, "tribunal.listing_statistics");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    // One reading of the query serves both the entitlement and the data. A repeated parameter
    // (`?saleId=U&saleId=V`) would be read as the first value by one and the last by the other, so
    // an unlock of U could open the tribunal of V: it is refused.
    for (const name of new Set(url.searchParams.keys())) {
      if (url.searchParams.getAll(name).length > 1) {
        throw new PublicApiError("Requête invalide : paramètre répété.", 400);
      }
    }
    const query = Object.fromEntries(url.searchParams.entries());
    // Analyse, or a Découverte account that unlocked the sale given as `saleId` (« 3 déblocages
    // par mois »): the tribunal of that sale only. A query by `courtCode` stays on Analyse. The
    // query is validated after the entitlement, as before; the schema then requires exactly one of
    // `courtCode` and `saleId`.
    const { door } = await assertFeatureEntitlementVia(
      auth,
      "sales.statistics",
      "Statistiques des annonces judiciaires réservées à l’offre Analyse.",
      { saleId: z.string().uuid().safeParse(query.saleId).data },
    );
    const input = tribunalListingStatisticsQuerySchema.parse(query);
    const statistics = tribunalListingStatisticsResponseSchema.parse(
      await getTribunalListingStatistics(input),
    );
    // An unlock opens the statistics of the tribunal, not the list of its other upcoming sales
    // (title, city, occupation, visit): that list stays with Analyse. The page does not show it
    // to an unlocked account either.
    if (door === "unlock") statistics.activity.upcomingListings = [];
    return apiJson(statistics, context, {
      headers: {
        "cache-control": "private, no-store",
        vary: "authorization",
      },
    });
  } catch (error) {
    if (error instanceof TribunalCourtUnresolvedError) {
      return apiJson(
        {
          ok: false,
          code: "COURT_UNRESOLVED",
          error: "Le rattachement exact au tribunal reste à confirmer.",
          requestId: context.requestId,
        },
        context,
        { status: 422 },
      );
    }
    const response = apiError(error, context, {
      fallbackMessage: "Statistiques des annonces du tribunal temporairement indisponibles.",
      fallbackStatus: 503,
    });
    response.headers.set("cache-control", "private, no-store");
    response.headers.set("vary", "authorization");
    return response;
  }
}
