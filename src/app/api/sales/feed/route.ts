import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiKeyAuthContextFromRequest } from "@/lib/api-keys";
import { exportSalesApiFeed } from "@/lib/sale-exports";
import { validateSalesSearch } from "@/lib/search/search-url-state";

export async function GET(request: Request) {
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

    return NextResponse.json(response, {
      headers: {
        "cache-control": "private, no-store",
        "x-immojudis-export-row-count": String(response.meta.rowCount),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Flux API ventes indisponible";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réservée")
        ? 403
        : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
