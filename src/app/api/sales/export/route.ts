import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { exportSalesCsv } from "@/lib/sale-exports";
import { validateSalesSearch } from "@/lib/search/search-url-state";
import { apiRoute } from "@/lib/api-route";

export const GET = apiRoute(
  { scope: "api.sales.export", fallbackMessage: "Export CSV impossible." },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const search = validateSalesSearch(Object.fromEntries(url.searchParams.entries()));
    const response = await exportSalesCsv({
      auth,
      search,
      origin: url.origin,
      request,
    });

    return new NextResponse(`\uFEFF${response.content}`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${response.filename}"`,
        "x-immojudis-export-row-count": String(response.rowCount),
      },
    });
  },
);
