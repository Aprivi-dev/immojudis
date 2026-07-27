import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiKeyAuthContextFromRequest } from "@/lib/api-keys";
import { exportSalesApiFeed } from "@/lib/sale-exports";
import { validateSalesSearch } from "@/lib/search/search-url-state";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";

export async function GET(request: Request) {
  const context = createApiRequestContext(request, "api.sales.feed");
  try {
    const apiKeyAuth = await apiKeyAuthContextFromRequest(request, "sales.feed:read");
    const auth = apiKeyAuth ?? (await requireSupabaseAuthContext(bearerTokenFromRequest(request)));
    const url = new URL(request.url);
    const search = validateSalesSearch(Object.fromEntries(url.searchParams.entries()));
    const response = await exportSalesApiFeed({
      auth,
      search,
      origin: url.origin,
    });

    return apiJson(response, context, {
      headers: {
        "cache-control": "private, no-store",
        "x-immojudis-export-row-count": String(response.meta.rowCount),
      },
    });
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Flux API ventes indisponible.",
      headers: { "retry-after": "60" },
    });
  }
}
