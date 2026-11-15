import { NextResponse } from "next/server";
import { z } from "zod";
import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  environmentalContextCacheControl,
  getEnvironmentalContext,
} from "@/lib/environmental-context";
import { enforceDailyOperationLimits, enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { assertFeatureEntitlementVia, getSaleForDoor } from "@/lib/entitlements.server";
import { saleLocation } from "@/lib/property-report/serialization";

const saleSchema = z.object({ saleId: z.string().guid() });

export const POST = apiRoute(
  {
    scope: "api.environment-context",
    fallbackMessage: "Contexte indisponible",
    emptyBody: { context: null },
  },
  async (request, { api }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "environment-context",
      ...RATE_LIMIT_POLICIES.compute,
      context: api,
    });
    const body: unknown = await request.json();
    // The offer, or a Découverte account that unlocked the sale named in the body (« déblocage du
    // compte gratuit »). Without a sale, only the offer opens the context.
    const saleId = saleSchema.safeParse(body).data?.saleId;
    const { plan, door } = await assertFeatureEntitlementVia(
      auth,
      "property.neighborhoodAnalysis",
      "Contexte environnemental réservé à l’offre Analyse.",
      { saleId },
    );
    // Après le droit d'accès : seul un compte qui y a droit use les compteurs de son adresse et le
    // disjoncteur global.
    await enforceDailyOperationLimits({
      request,
      userId: auth.userId,
      operation: "environmentContext",
      launchOffer: plan.launchOffer === true,
    });
    // Through an unlock, the place is the sale's, read on the server: an address or coordinates
    // sent in the body are ignored, so a free account cannot query a place of its choosing. The
    // offer keeps the free query.
    const input = door === "unlock" && saleId ? await saleEnvironmentInput(auth, saleId) : body;
    const response = await getEnvironmentalContext(input);
    return NextResponse.json(response, {
      headers: {
        "cache-control": environmentalContextCacheControl(response),
      },
    });
  },
);

async function saleEnvironmentInput(auth: Parameters<typeof getSaleForDoor>[0], saleId: string) {
  const { sale } = await getSaleForDoor(auth, saleId, "unlock");
  return { address: saleLocation(sale), lat: sale.latitude, lng: sale.longitude };
}
