import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { exportSalesCsv } from "@/lib/sale-exports";
import { validateSalesSearch } from "@/lib/search/search-url-state";
import { apiError, createApiRequestContext, withApiHeaders } from "@/lib/api-observability";

export async function GET(request: Request) {
  const context = createApiRequestContext(request, "api.sales.export");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const search = validateSalesSearch(Object.fromEntries(url.searchParams.entries()));
    const response = await exportSalesCsv({
      auth,
      search,
      origin: url.origin,
    });

    return withApiHeaders(
      new NextResponse(`\uFEFF${response.content}`, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${response.filename}"`,
          "x-immojudis-export-row-count": String(response.rowCount),
        },
      }),
      context,
    );
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Export CSV impossible.",
      headers: { "retry-after": "60" },
    });
  }
}
