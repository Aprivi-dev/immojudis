import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { bidCeilingRequestSchema, calculateBidCeiling } from "@/lib/bid-ceiling";

export async function POST(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = bidCeilingRequestSchema.parse(await request.json());
    const response = await calculateBidCeiling({ auth, input });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiRouteError(error, request, "bid-ceiling", {
      fallbackMessage: "Calcul de mise maximale impossible",
    });
  }
}
