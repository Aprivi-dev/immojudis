import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import { assertFeatureEntitlement } from "@/lib/property-reports";
import {
  getTribunalStatistics,
  tribunalStatisticsQuerySchema,
} from "@/lib/tribunal-statistics-repository";
import { recordFeatureUsageEvent } from "@/lib/usage";

export async function GET(request: Request) {
  const context = createApiRequestContext(request, "tribunal.statistics");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await assertFeatureEntitlement(
      auth,
      "sales.statistics",
      "Statistiques par tribunal réservées au plan Analyse.",
    );

    const url = new URL(request.url);
    const input = tribunalStatisticsQuerySchema.parse(
      Object.fromEntries(url.searchParams.entries()),
    );
    const statistics = await getTribunalStatistics(input);

    // This is deliberately fire-and-forget: a slow or unavailable telemetry
    // store must never delay or fail an otherwise valid premium read.
    recordUsageSafely({
      auth,
      eventKey: "tribunal.statistics_viewed",
      subjectType: "tribunal_statistics",
      metadata: {
        window_months: input.windowMonths,
        court_code: input.courtCode ?? null,
        tribunal_count: statistics.tribunals.length,
        national_reliability: statistics.national.reliability.level,
        experimental: true,
      },
    });

    return apiJson(statistics, context, {
      headers: {
        "cache-control": "private, no-store",
        vary: "authorization",
      },
    });
  } catch (error) {
    const response = apiError(error, context, {
      fallbackMessage: "Statistiques par tribunal temporairement indisponibles.",
      fallbackStatus: 503,
    });
    response.headers.set("cache-control", "private, no-store");
    response.headers.set("vary", "authorization");
    return response;
  }
}

function recordUsageSafely(input: Parameters<typeof recordFeatureUsageEvent>[0]): void {
  try {
    void recordFeatureUsageEvent(input).catch(() => undefined);
  } catch {
    // A synchronous adapter failure is non-critical for this read endpoint.
  }
}
