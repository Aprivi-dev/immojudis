import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { getAdjudicationPriceStatisticsDirectory } from "@/lib/adjudication-price-statistics-repository";
import { apiRoute } from "@/lib/api-route";
import { assertFeatureEntitlement } from "@/lib/entitlements.server";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { recordFeatureUsageEvent } from "@/lib/usage";

export const GET = apiRoute(
  {
    scope: "adjudication-price-statistics.directory",
    fallbackMessage: "Statistiques d’adjudication temporairement indisponibles.",
    fallbackStatus: 503,
    versionedApi: true,
  },
  async (request, { api }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      context: api,
      bucketKey: "v1.tribunal-adjudication-statistics",
      ...RATE_LIMIT_POLICIES.compute,
    });
    await assertFeatureEntitlement(
      auth,
      "sales.statistics",
      "Statistiques d’adjudication réservées à l’offre Analyse.",
    );
    const statistics = await getAdjudicationPriceStatisticsDirectory();
    recordFeatureUsageEvent({
      auth,
      eventKey: "tribunal.statistics_viewed",
      subjectType: "tribunal_statistics",
      metadata: {
        national_sample_size: statistics.national.sampleSize,
        tribunal_count: statistics.tribunals.length,
        experimental: true,
      },
    });
    return statistics;
  },
);
