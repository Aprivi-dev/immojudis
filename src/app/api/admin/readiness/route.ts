import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { getAdminOperationalReadiness } from "@/lib/admin-readiness";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const response = await getAdminOperationalReadiness(bearerTokenFromRequest(request));
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Diagnostic indisponible";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.startsWith("Forbidden")
        ? 403
        : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
