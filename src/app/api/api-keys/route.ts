import { NextResponse } from "next/server";
import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiKeyCreateInputSchema, createUserApiKey, listUserApiKeys } from "@/lib/api-keys";

export const GET = apiRoute(
  { scope: "api.api-keys.list", fallbackMessage: "Clés API indisponibles" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    return listUserApiKeys({ auth });
  },
);

export const POST = apiRoute(
  { scope: "api.api-keys.create", fallbackMessage: "Clés API indisponibles" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = apiKeyCreateInputSchema.parse(await request.json());
    const response = await createUserApiKey({ auth, input, request });
    return NextResponse.json(response, { status: 201 });
  },
);
