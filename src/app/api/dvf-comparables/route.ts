import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { dvfComparablesQuerySchema, getDvfComparables } from "@/lib/dvf-comparables";

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const input = dvfComparablesQuerySchema.parse(Object.fromEntries(url.searchParams.entries()));
    const response = await getDvfComparables({ auth, input });

    return NextResponse.json(response, {
      headers: {
        "cache-control": "private, no-store",
        "x-immojudis-dvf-sample-size": String(response.analysis.sampleSize),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Comparables DVF indisponibles";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réservé")
        ? 403
        : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
