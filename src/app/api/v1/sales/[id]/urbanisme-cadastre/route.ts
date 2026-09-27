import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import { assertFeatureEntitlement } from "@/lib/property-reports";
import {
  getCadastralParcels,
  getSale,
  getUrbanPlanningSignals,
} from "@/lib/property-report/repository";

const paramsSchema = z.object({ id: z.string().uuid() });

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = createApiRequestContext(request, "urbanisme-cadastre.sale");

  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await assertFeatureEntitlement(
      auth,
      "property.cadastralAnalysis",
      "Les données cadastrales sont réservées au plan Analyse.",
    );
    await assertFeatureEntitlement(
      auth,
      "property.urbanPlanning",
      "Les données d’urbanisme sont réservées au plan Analyse.",
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
    const response = apiError(error, context, {
      fallbackMessage: "Données d’urbanisme et cadastrales temporairement indisponibles.",
      fallbackStatus: 503,
    });
    response.headers.set("cache-control", "private, no-store");
    response.headers.set("vary", "authorization");
    return response;
  }
}
