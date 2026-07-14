import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { getValuationAdminOverview } from "@/lib/valuation-admin";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const overview = await getValuationAdminOverview(bearerTokenFromRequest(request));
    return NextResponse.json(overview, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Modèles de valorisation indisponibles";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.startsWith("Forbidden")
        ? 403
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
