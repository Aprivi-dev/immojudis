import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiKeyCreateInputSchema, createUserApiKey, listUserApiKeys } from "@/lib/api-keys";

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const response = await listUserApiKeys({ auth });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiKeyErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = apiKeyCreateInputSchema.parse(await request.json());
    const response = await createUserApiKey({ auth, input });
    return NextResponse.json(response, {
      status: 201,
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiKeyErrorResponse(error);
  }
}

function apiKeyErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Clés API indisponibles";
  const status = message.startsWith("Unauthorized")
    ? 401
    : message.includes("réservées") || message.includes("Limite")
      ? 403
      : 400;
  return NextResponse.json({ ok: false, error: message }, { status });
}
