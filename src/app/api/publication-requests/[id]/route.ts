import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { getPublicationRequest } from "@/lib/publication-requests";

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
    return apiRouteError(error, request, "publication-requests.id", {
      fallbackMessage: "Demande de publication indisponible",
      extra: { request: null },
    });
  }
}
