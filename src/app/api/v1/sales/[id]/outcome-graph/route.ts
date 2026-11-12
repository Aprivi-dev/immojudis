import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiRoute } from "@/lib/api-route";
import { getOutcomeGraphForecastForSale } from "@/lib/outcome-graph-repository";
import { assertFeatureEntitlement } from "@/lib/entitlements.server";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { recordFeatureUsageEvent } from "@/lib/usage";

const paramsSchema = z.object({ id: z.string().guid() });

export const GET = apiRoute<{ id: string }>(
  {
    scope: "outcome-graph.forecast",
    fallbackMessage: "Prévision de l’audience indisponible.",
    versionedApi: true,
  },
  async (request, { api, params }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      context: api,
      bucketKey: "v1.sale-outcome-graph",
      ...RATE_LIMIT_POLICIES.compute,
    });
    await assertFeatureEntitlement(
      auth,
      "property.outcomeGraph",
      "Prévision Outcome Graph réservée à l’offre Analyse.",
    );
    const { id: saleId } = paramsSchema.parse(params);
    const forecast = await getOutcomeGraphForecastForSale(saleId);

    recordFeatureUsageEvent({
      auth,
      eventKey: "outcome_graph.viewed",
      subjectType: "auction_sale",
      subjectId: saleId,
      metadata: {
        status: forecast.status,
        model_version: forecast.modelVersion,
        prediction_id: forecast.predictionId,
        snapshot_id: forecast.snapshotId,
      },
    });

    return { forecast };
  },
);
