import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { exportSalesCsv } from "@/lib/sale-exports";
import { validateSalesSearch } from "@/lib/search/search-url-state";

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const search = validateSalesSearch(Object.fromEntries(url.searchParams.entries()));
    const response = await exportSalesCsv({
      auth,
      search,
      origin: url.origin,
    });

    return new NextResponse(`\uFEFF${response.content}`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${response.filename}"`,
        "x-immojudis-export-row-count": String(response.rowCount),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Export CSV impossible";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réservé")
        ? 403
        : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
