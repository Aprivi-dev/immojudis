import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import { saleNotFoundAsPublicError } from "@/lib/api-sale-not-found";
import { assertFeatureEntitlement } from "@/lib/property-reports";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import {
  getCadastralParcels,
  getSale,
  getUrbanPlanningSignals,
} from "@/lib/property-report/repository";

const paramsSchema = z.object({ id: z.string().guid() });

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = createApiRequestContext(request, "urbanisme-cadastre.sale");

  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      context,
      bucketKey: "v1.sale-urbanisme-cadastre",
      ...RATE_LIMIT_POLICIES.compute,
    });
    await assertFeatureEntitlement(
      auth,
      "property.cadastralAnalysis",
      "Les données cadastrales sont réservées à l’offre Analyse.",
    );
    await assertFeatureEntitlement(
      auth,
      "property.urbanPlanning",
      "Les données d’urbanisme sont réservées à l’offre Analyse.",
    );

    const { id: saleId } = paramsSchema.parse(await params);
    const sale = await getSale(auth.supabase, saleId);
    const [cadastralParcels, urbanPlanningSignals] = await Promise.all([
      getCadastralParcels(sale.source_url),
      getUrbanPlanningSignals(sale.source_url),
    ]);

    return apiJson({ cadastralParcels, urbanPlanningSignals }, context, {
      headers: {
        "cache-control": "private, no-store",
        vary: "authorization",
      },
    });
  } catch (error) {
    const response = apiError(saleNotFoundAsPublicError(error), context, {
      fallbackMessage: "Données d’urbanisme et cadastrales temporairement indisponibles.",
      fallbackStatus: 503,
    });
    response.headers.set("cache-control", "private, no-store");
    response.headers.set("vary", "authorization");
    return response;
  }
}
