import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { getAdminDashboard } from "@/lib/admin.functions";

export async function GET(request: Request) {
  try {
    const dashboard = await getAdminDashboard(bearerTokenFromRequest(request));
    return NextResponse.json(dashboard, {
      headers: {
        "cache-control": "private, max-age=30",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur admin";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.startsWith("Forbidden")
        ? 403
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
