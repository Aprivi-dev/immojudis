import { NextResponse } from "next/server";
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
    const message = error instanceof Error ? error.message : "Calcul de mise maximale impossible";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réservé")
        ? 403
        : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
