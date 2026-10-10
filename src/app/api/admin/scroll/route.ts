import { NextResponse } from "next/server";
import { z } from "zod";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { startAdminScroll } from "@/lib/admin.functions";
import { isPublicErrorMessage } from "@/lib/api-errors";
import { adminErrorResponse } from "@/lib/api-route-errors";
import { withAdminDeadline } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

async function handlePOST(request: Request) {
  try {
    const result = await startAdminScroll(bearerTokenFromRequest(request), await request.json());
    if (!result.ok || !result.dispatched) {
      // The dispatch summary is composed by our own code, but never forward anything
      // that does not read like a user-facing message.
      const publicMessage = isPublicErrorMessage(result.message)
        ? result.message
        : "La collecte n'a pas pu être lancée.";
      return NextResponse.json(
        { ...result, message: publicMessage, error: publicMessage },
        { status: 502 },
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    return adminErrorResponse(error, {
      fallbackStatus: error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500,
    });
  }
}

export const POST = withAdminDeadline(handlePOST);
