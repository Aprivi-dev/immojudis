import { NextResponse } from "next/server";
import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { getPublicationRequest } from "@/lib/publication-requests";

export const GET = apiRoute<{ id: string }>(
  {
    scope: "api.publication-requests.read",
    fallbackMessage: "Demande de publication indisponible",
    emptyBody: { request: null },
  },
  async (request, { params }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    return NextResponse.json(await getPublicationRequest({ auth, requestId: params.id }), {
      headers: { "referrer-policy": "no-referrer" },
    });
  },
);
