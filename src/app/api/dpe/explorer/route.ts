import { NextResponse } from "next/server";
import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { dpeExplorerQuerySchema, getDpeExplorer } from "@/lib/dpe-explorer";

export const GET = apiRoute(
  { scope: "dpe.explorer", fallbackMessage: "Explorateur DPE indisponible" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const input = dpeExplorerQuerySchema.parse(Object.fromEntries(url.searchParams.entries()));
    const response = await getDpeExplorer({ auth, input });

    return NextResponse.json(response, {
      headers: { "x-immojudis-dpe-count": String(response.summary.total) },
    });
  },
);
