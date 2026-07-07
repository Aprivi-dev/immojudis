import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { getSalesStatistics } from "@/lib/sales-statistics";
import { validateSalesSearch } from "@/lib/search/search-url-state";

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const search = validateSalesSearch(Object.fromEntries(url.searchParams.entries()));
    const response = await getSalesStatistics({ auth, search });
    return NextResponse.json(response, {
      headers: {
        "cache-control": "private, no-store",
        "x-immojudis-statistics-sample-size": String(response.summary.sampleSize),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Statistiques indisponibles";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réservées")
        ? 403
        : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
