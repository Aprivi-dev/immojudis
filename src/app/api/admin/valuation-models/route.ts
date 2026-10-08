import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { getValuationAdminOverview } from "@/lib/valuation-admin";
import { adminErrorResponse } from "@/lib/api-route-errors";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const overview = await getValuationAdminOverview(bearerTokenFromRequest(request));
    return NextResponse.json(overview, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error, {
      fallbackMessage: "Modèles de valorisation indisponibles",
      fallbackStatus: 500,
    });
  }
}
