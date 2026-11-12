import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiRoute } from "@/lib/api-route";
import { assertFeatureEntitlement } from "@/lib/property-reports";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import {
  getCadastralParcels,
  getSale,
  getUrbanPlanningSignals,
} from "@/lib/property-report/repository";

const paramsSchema = z.object({ id: z.string().guid() });

export const GET = apiRoute<{ id: string }>(
  {
    scope: "urbanisme-cadastre.sale",
    fallbackMessage: "Données d’urbanisme et cadastrales temporairement indisponibles.",
    fallbackStatus: 503,
    versionedApi: true,
  },
  async (request, { api, params }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      context: api,
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

    const { id: saleId } = paramsSchema.parse(params);
    const sale = await getSale(auth.supabase, saleId);
    const [cadastralParcels, urbanPlanningSignals] = await Promise.all([
      getCadastralParcels(sale.source_url),
      getUrbanPlanningSignals(sale.source_url),
    ]);

    return { cadastralParcels, urbanPlanningSignals };
  },
);
