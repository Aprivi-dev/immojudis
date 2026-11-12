import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { getAdjudicationPriceStatisticsForSale } from "@/lib/adjudication-price-statistics-repository";
import { apiRoute } from "@/lib/api-route";
import { assertFeatureEntitlement } from "@/lib/entitlements.server";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { recordFeatureUsageEvent } from "@/lib/usage";

const paramsSchema = z.object({ id: z.string().guid() });

export const GET = apiRoute<{ id: string }>(
  {
    scope: "adjudication-price-statistics.sale",
    fallbackMessage: "Statistiques d’adjudication temporairement indisponibles.",
    fallbackStatus: 503,
    versionedApi: true,
  },
  async (request, { api, params }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      context: api,
      bucketKey: "v1.sale-adjudication-statistics",
      ...RATE_LIMIT_POLICIES.compute,
    });
    // Analyse, or a Découverte account that unlocked this very sale (« 3 déblocages par mois »):
    // the statistics of the tribunal of this sale only. The identifier is validated after the
    // entitlement, as before; an invalid one simply cannot match an unlock.
    await assertFeatureEntitlement(
      auth,
      "sales.statistics",
      "Statistiques d’adjudication réservées à l’offre Analyse.",
      { saleId: paramsSchema.safeParse(params).data?.id },
    );
    const { id: saleId } = paramsSchema.parse(params);
    const statistics = await getAdjudicationPriceStatisticsForSale(saleId);

    recordFeatureUsageEvent({
      auth,
      eventKey: "tribunal.statistics_viewed",
      subjectType: "auction_sale",
      subjectId: saleId,
      metadata: {
        window_months: 36,
        national_sample_size: statistics.national.sampleSize,
        tribunal_available: statistics.tribunal !== null,
        experimental: true,
      },
    });

    return statistics;
  },
);
