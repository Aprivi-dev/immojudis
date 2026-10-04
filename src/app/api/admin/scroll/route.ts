import { NextResponse } from "next/server";
import { z } from "zod";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { startAdminScroll } from "@/lib/admin.functions";
import { adminErrorResponse } from "@/lib/api-route-errors";

export async function POST(request: Request) {
  try {
    const result = await startAdminScroll(bearerTokenFromRequest(request), await request.json());
    if (!result.ok || !result.dispatched) {
      return NextResponse.json({ ...result, error: result.message }, { status: 502 });
    }
    return NextResponse.json(result);
  } catch (error) {
    return adminErrorResponse(error, {
      fallbackStatus: error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500,
    });
  }
}
