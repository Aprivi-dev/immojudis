import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import { getOutcomeGraphForecastForSale } from "@/lib/outcome-graph-repository";
import { assertFeatureEntitlement } from "@/lib/property-reports";
import { recordFeatureUsageEvent } from "@/lib/usage";

const paramsSchema = z.object({ id: z.string().uuid() });

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = createApiRequestContext(request, "outcome-graph.forecast");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await assertFeatureEntitlement(
      auth,
      "property.outcomeGraph",
      "Prévision Outcome Graph réservée au plan Analyse.",
    );
    const { id: saleId } = paramsSchema.parse(await params);
    const forecast = await getOutcomeGraphForecastForSale(saleId);

    await recordFeatureUsageEvent({
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

    return apiJson({ forecast }, context, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Prévision de l’audience indisponible.",
    });
  }
}
