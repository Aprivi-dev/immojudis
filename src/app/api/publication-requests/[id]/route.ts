import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { getPublicationRequest } from "@/lib/publication-requests";

const PRIVATE_AUTH_HEADERS = {
  "cache-control": "private, no-store",
  vary: "authorization",
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const { id } = await context.params;
    return NextResponse.json(await getPublicationRequest({ auth, requestId: id }), {
      headers: {
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Demande de publication indisponible";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.startsWith("Forbidden")
        ? 403
        : message.startsWith("NotFound")
          ? 404
          : 400;
    return NextResponse.json(
      { request: null, error: message },
      { status, headers: PRIVATE_AUTH_HEADERS },
    );
  }
}
