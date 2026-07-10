import { NextResponse } from "next/server";
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
    const message = error instanceof Error ? error.message : "Contexte indisponible";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réserv")
        ? 403
        : 400;
    return NextResponse.json({ ok: false, error: message, context: null }, { status });
  }
}
