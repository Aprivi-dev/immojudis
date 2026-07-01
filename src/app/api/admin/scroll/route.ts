import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { startAdminScroll } from "@/lib/admin.functions";

export async function POST(request: Request) {
  try {
    const result = await startAdminScroll(bearerTokenFromRequest(request), await request.json());
    return NextResponse.json(result);
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
