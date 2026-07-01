import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { getMarketEstimate, marketEstimateCacheControl } from "@/lib/market.functions";

export async function POST(request: Request) {
  try {
    await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const response = await getMarketEstimate(await request.json());
    return NextResponse.json(response, {
      headers: {
        "cache-control": marketEstimateCacheControl(response),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unauthorized";
    const status = message.startsWith("Unauthorized") ? 401 : 400;
    return NextResponse.json({ ok: false, error: message, estimate: null }, { status });
  }
}
