import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiRoute } from "@/lib/api-route";
import { assertFeatureEntitlementVia, getSaleForDoor } from "@/lib/entitlements.server";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { urbanPlanningSignalsForDoor } from "@/lib/property-report/entitlements";
import { getCadastralParcels, getUrbanPlanningSignals } from "@/lib/property-report/repository";

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
    // Analyse, or a Découverte account that unlocked this very sale (« déblocage du compte gratuit
    // »). The identifier is validated after the entitlements, as before; an invalid one simply
    // cannot match an unlock. Both rights open through the same door (the offer has both or neither,
    // an unlock opens both).
    const unlockSaleId = paramsSchema.safeParse(params).data?.id;
    await assertFeatureEntitlementVia(
      auth,
      "property.cadastralAnalysis",
      "Les données cadastrales sont réservées à l’offre Analyse.",
      { saleId: unlockSaleId },
    );
    const { door } = await assertFeatureEntitlementVia(
      auth,
      "property.urbanPlanning",
      "Les données d’urbanisme sont réservées à l’offre Analyse.",
      { saleId: unlockSaleId },
    );

    const { id: saleId } = paramsSchema.parse(params);
    // The enrichment rows are found by the sale's key, read on the server and never returned.
    const { enrichmentKey } = await getSaleForDoor(auth, saleId, door);
    const [cadastralParcels, signals] = await Promise.all([
      getCadastralParcels(enrichmentKey),
      getUrbanPlanningSignals(enrichmentKey),
    ]);
    // Through an unlock, only the signals read in what the sale already serves (pieces, title,
    // description): never an excerpt of the raw payload or of another source.
    const urbanPlanningSignals = urbanPlanningSignalsForDoor(signals, door);

    return { cadastralParcels, urbanPlanningSignals };
  },
);
