import { NextResponse } from "next/server";
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
import { assertFeatureEntitlement } from "@/lib/entitlements.server";

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
    const plan = await assertFeatureEntitlement(
      auth,
      "property.neighborhoodAnalysis",
      "Contexte environnemental réservé à l’offre Analyse.",
    );
    // Après le droit d'accès : seul un compte qui y a droit use les compteurs de son adresse et le
    // disjoncteur global.
    await enforceDailyOperationLimits({
      request,
      userId: auth.userId,
      operation: "environmentContext",
      launchOffer: plan.launchOffer === true,
    });
    const response = await getEnvironmentalContext(await request.json());
    return NextResponse.json(response, {
      headers: {
        "cache-control": environmentalContextCacheControl(response),
      },
    });
  },
);
