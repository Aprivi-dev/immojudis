import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import { assertFeatureEntitlement } from "@/lib/property-reports";
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
    await assertFeatureEntitlement(
      auth,
      "sales.statistics",
      "Statistiques des annonces judiciaires réservées au plan Analyse.",
    );
    const url = new URL(request.url);
    const input = tribunalListingStatisticsQuerySchema.parse(
      Object.fromEntries(url.searchParams.entries()),
    );
    const statistics = tribunalListingStatisticsResponseSchema.parse(
      await getTribunalListingStatistics(input),
    );
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
