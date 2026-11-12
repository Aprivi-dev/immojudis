import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  dataRefreshListQuerySchema,
  dataRefreshRequestSchema,
  listDataRefreshRequests,
  requestDataRefresh,
} from "@/lib/data-refresh";
import { apiRoute } from "@/lib/api-route";

export const GET = apiRoute(
  { scope: "api.data-refresh.list", fallbackMessage: "Demandes de refresh indisponibles." },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const input = dataRefreshListQuerySchema.parse(Object.fromEntries(url.searchParams.entries()));
    const response = await listDataRefreshRequests({ auth, input });

    return NextResponse.json(response, {
      headers: { "x-immojudis-refresh-count": String(response.requests.length) },
    });
  },
);

export const POST = apiRoute(
  { scope: "api.data-refresh.create", fallbackMessage: "Refresh DPE/cadastre impossible." },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = dataRefreshRequestSchema.parse(await request.json());
    const response = await requestDataRefresh({ auth, input, request });

    return NextResponse.json(response, {
      status: 202,
      headers: { "x-immojudis-refresh-count": String(response.requests.length) },
    });
  },
);
