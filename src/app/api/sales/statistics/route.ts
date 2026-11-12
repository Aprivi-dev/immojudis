import { NextResponse } from "next/server";
import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { getSalesStatistics } from "@/lib/sales-statistics";
import { validateSalesSearch } from "@/lib/search/search-url-state";

export const GET = apiRoute(
  { scope: "sales.statistics", fallbackMessage: "Statistiques indisponibles" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const search = validateSalesSearch(Object.fromEntries(url.searchParams.entries()));
    const response = await getSalesStatistics({ auth, search });
    return NextResponse.json(response, {
      headers: { "x-immojudis-statistics-sample-size": String(response.summary.sampleSize) },
    });
  },
);
