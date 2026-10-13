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
    const rawParams = await params;
    // Analyse, or a Découverte account that unlocked this very sale (« 3 déblocages par mois »).
    // The identifier is validated after the entitlement, as before; an invalid one simply cannot
    // match an unlock.
    await assertFeatureEntitlement(
      auth,
      "property.outcomeGraph",
      "Prévision Outcome Graph réservée au plan Analyse.",
      { saleId: paramsSchema.safeParse(rawParams).data?.id },
    );
    const { id: saleId } = paramsSchema.parse(rawParams);
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
