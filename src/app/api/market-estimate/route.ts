import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { getMarketEstimate, marketEstimateCacheControl } from "@/lib/market.functions";
import { assertFeatureEntitlement } from "@/lib/property-reports";

export async function POST(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await assertFeatureEntitlement(
      auth,
      "property.valueEstimate",
      "Estimation de marché réservée au plan Analyse.",
    );
    const response = await getMarketEstimate(await request.json());
    return NextResponse.json(response, {
      headers: {
        "cache-control": marketEstimateCacheControl(response),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unauthorized";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réserv")
        ? 403
        : 400;
    return NextResponse.json({ ok: false, error: message, estimate: null }, { status });
  }
}
