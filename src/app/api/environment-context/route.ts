import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  environmentalContextCacheControl,
  getEnvironmentalContext,
} from "@/lib/environment.functions";
import { assertFeatureEntitlement } from "@/lib/property-reports";

export async function POST(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await assertFeatureEntitlement(
      auth,
      "property.neighborhoodAnalysis",
      "Contexte environnemental réservé au plan Analyse.",
    );
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
