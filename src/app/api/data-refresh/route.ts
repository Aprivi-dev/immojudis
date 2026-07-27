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
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";

export async function GET(request: Request) {
  const context = createApiRequestContext(request, "api.data-refresh.list");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const input = dataRefreshListQuerySchema.parse(Object.fromEntries(url.searchParams.entries()));
    const response = await listDataRefreshRequests({ auth, input });

    return apiJson(response, context, {
      headers: {
        "cache-control": "private, no-store",
        "x-immojudis-refresh-count": String(response.requests.length),
      },
    });
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Demandes de refresh indisponibles.",
    });
  }
}

export async function POST(request: Request) {
  const context = createApiRequestContext(request, "api.data-refresh.create");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = dataRefreshRequestSchema.parse(await request.json());
    const response = await requestDataRefresh({ auth, input });

    return apiJson(response, context, {
      status: 202,
      headers: {
        "cache-control": "private, no-store",
        "x-immojudis-refresh-count": String(response.requests.length),
      },
    });
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Refresh DPE/cadastre impossible.",
    });
  }
}
