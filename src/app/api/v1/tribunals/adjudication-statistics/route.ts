import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import { getAdjudicationPriceStatisticsDirectory } from "@/lib/adjudication-price-statistics-repository";
import { assertFeatureEntitlement } from "@/lib/property-reports";
import { recordFeatureUsageEvent } from "@/lib/usage";

export async function GET(request: Request) {
  const context = createApiRequestContext(request, "adjudication-price-statistics.directory");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await assertFeatureEntitlement(
      auth,
      "sales.statistics",
      "Statistiques d’adjudication réservées au plan Analyse.",
    );
    const statistics = await getAdjudicationPriceStatisticsDirectory();
    try {
      void recordFeatureUsageEvent({
        auth,
        eventKey: "tribunal.statistics_viewed",
        subjectType: "tribunal_statistics",
        metadata: {
          national_sample_size: statistics.national.sampleSize,
          tribunal_count: statistics.tribunals.length,
          experimental: true,
        },
      }).catch(() => undefined);
    } catch {
      // Telemetry cannot block a premium read.
    }
    return apiJson(statistics, context, {
      headers: { "cache-control": "private, no-store", vary: "authorization" },
    });
  } catch (error) {
    const response = apiError(error, context, {
      fallbackMessage: "Statistiques d’adjudication temporairement indisponibles.",
      fallbackStatus: 503,
    });
    response.headers.set("cache-control", "private, no-store");
    response.headers.set("vary", "authorization");
    return response;
  }
}
