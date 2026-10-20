import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import { getCourtAuctionSummaries } from "@/lib/auction-scenarios.server";
import { assertFeatureEntitlement } from "@/lib/property-reports";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";

/** Three years of adjudications per court (Licitor and DVF), for the Analyse offer. */
export async function GET(request: Request) {
  const context = createApiRequestContext(request, "tribunals.auction-summaries");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "v1.tribunal-auction-summaries",
      ...RATE_LIMIT_POLICIES.compute,
    });
    await assertFeatureEntitlement(
      auth,
      "sales.statistics",
      "Les statistiques d’adjudication sont réservées à l’offre Analyse.",
    );
    const courts = await getCourtAuctionSummaries();
    return apiJson({ courts }, context, {
      headers: { "cache-control": "private, no-store", vary: "authorization" },
    });
  } catch (error) {
    const response = apiError(error, context, {
      fallbackMessage: "Statistiques d’adjudication temporairement indisponibles.",
      fallbackStatus: 503,
    });
    response.headers.set("cache-control", "private, no-store");
    return response;
  }
}
