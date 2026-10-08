import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { getAdminOperationalReadiness } from "@/lib/admin-readiness";
import { adminErrorResponse } from "@/lib/api-route-errors";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const response = await getAdminOperationalReadiness(bearerTokenFromRequest(request));
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error, { fallbackMessage: "Diagnostic indisponible" });
  }
}
