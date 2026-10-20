import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
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
import { assertFeatureEntitlement } from "@/lib/property-reports";

export async function POST(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "environment-context",
      ...RATE_LIMIT_POLICIES.compute,
    });
    await assertFeatureEntitlement(
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
    });
    const response = await getEnvironmentalContext(await request.json());
    return NextResponse.json(response, {
      headers: {
        "cache-control": environmentalContextCacheControl(response),
      },
    });
  } catch (error) {
    return apiRouteError(error, request, "environment-context", {
      fallbackMessage: "Contexte indisponible",
      extra: { context: null },
    });
  }
}
