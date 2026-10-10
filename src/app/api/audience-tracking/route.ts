import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { getAudienceTracking } from "@/lib/audience-tracking";

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const response = await getAudienceTracking({
      auth,
      includeArchived: url.searchParams.get("includeArchived") === "true",
    });

    return NextResponse.json(response, {
      headers: {
        "cache-control": "private, no-store",
        "x-immojudis-audience-workspaces": String(response.summary.totalWorkspaces),
      },
    });
  } catch (error) {
    return apiRouteError(error, request, "audience-tracking", {
      fallbackMessage: "Suivi d'audience indisponible",
    });
  }
}
