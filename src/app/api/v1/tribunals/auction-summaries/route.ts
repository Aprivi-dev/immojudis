import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiRoute } from "@/lib/api-route";
import { getCourtAuctionSummaries } from "@/lib/auction-scenarios.server";
import { assertFeatureEntitlement } from "@/lib/entitlements.server";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";

/** Three years of adjudications per court (Licitor and DVF), for the Analyse offer. */
export const GET = apiRoute(
  {
    scope: "tribunals.auction-summaries",
    fallbackMessage: "Statistiques d’adjudication temporairement indisponibles.",
    fallbackStatus: 503,
    versionedApi: true,
  },
  async (request, { api }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      context: api,
      bucketKey: "v1.tribunal-auction-summaries",
      ...RATE_LIMIT_POLICIES.compute,
    });
    await assertFeatureEntitlement(
      auth,
      "sales.statistics",
      "Les statistiques d’adjudication sont réservées à l’offre Analyse.",
    );
    const courts = await getCourtAuctionSummaries();
    return { generatedAt: new Date().toISOString(), courts };
  },
);
