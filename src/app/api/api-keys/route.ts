import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
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
    return apiKeyErrorResponse(error, request);
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
    return apiKeyErrorResponse(error, request);
  }
}

function apiKeyErrorResponse(error: unknown, request: Request) {
  return apiRouteError(error, request, "api-keys", {
    fallbackMessage: "Clés API indisponibles",
  });
}
