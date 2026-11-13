import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiRoute } from "@/lib/api-route";
import { assertFeatureEntitlement } from "@/lib/entitlements.server";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import {
  getTribunalStatistics,
  tribunalStatisticsQuerySchema,
} from "@/lib/tribunal-statistics-repository";
import { recordFeatureUsageEvent } from "@/lib/usage";

export const GET = apiRoute(
  {
    scope: "tribunal.statistics",
    fallbackMessage: "Statistiques par tribunal temporairement indisponibles.",
    fallbackStatus: 503,
    versionedApi: true,
  },
  async (request, { api }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      context: api,
      bucketKey: "v1.tribunal-statistics",
      ...RATE_LIMIT_POLICIES.compute,
    });
    await assertFeatureEntitlement(
      auth,
      "sales.statistics",
      "Statistiques par tribunal réservées à l’offre Analyse.",
    );

    const url = new URL(request.url);
    const input = tribunalStatisticsQuerySchema.parse(
      Object.fromEntries(url.searchParams.entries()),
    );
    const statistics = await getTribunalStatistics(input);

    recordFeatureUsageEvent({
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

    return statistics;
  },
);
