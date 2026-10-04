import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { getAdminDashboard } from "@/lib/admin.functions";
import { adminErrorResponse } from "@/lib/api-route-errors";

export async function GET(request: Request) {
  try {
    const dashboard = await getAdminDashboard(bearerTokenFromRequest(request));
    return NextResponse.json(dashboard, {
      headers: {
        "cache-control": "private, max-age=30",
      },
    });
  } catch (error) {
    return adminErrorResponse(error, { fallbackStatus: 500 });
  }
}
