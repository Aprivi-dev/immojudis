import { NextResponse } from "next/server";
import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { getAudienceTracking } from "@/lib/audience-tracking";

export const GET = apiRoute(
  { scope: "api.audience-tracking", fallbackMessage: "Suivi d'audience indisponible" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const response = await getAudienceTracking({
      auth,
      includeArchived: url.searchParams.get("includeArchived") === "true",
    });

    return NextResponse.json(response, {
      headers: {
        "x-immojudis-audience-workspaces": String(response.summary.totalWorkspaces),
      },
    });
  },
);
