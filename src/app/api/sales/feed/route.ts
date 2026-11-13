import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiKeyAuthContextFromRequest } from "@/lib/api-keys";
import { exportSalesApiFeed } from "@/lib/sale-exports";
import { catalogueSearch } from "@/lib/search/search-filters";
import { validateSalesSearch } from "@/lib/search/search-url-state";
import { apiRoute } from "@/lib/api-route";

export const GET = apiRoute(
  { scope: "api.sales.feed", fallbackMessage: "Flux API ventes indisponible." },
  async (request) => {
    const apiKeyAuth = await apiKeyAuthContextFromRequest(request, "sales.feed:read");
    const auth = apiKeyAuth ?? (await requireSupabaseAuthContext(bearerTokenFromRequest(request)));
    const url = new URL(request.url);
    const search = catalogueSearch(
      validateSalesSearch(Object.fromEntries(url.searchParams.entries())),
    );
    const response = await exportSalesApiFeed({
      auth,
      search,
      origin: url.origin,
      request,
    });

    return NextResponse.json(response, {
      headers: { "x-immojudis-export-row-count": String(response.meta.rowCount) },
    });
  },
);
