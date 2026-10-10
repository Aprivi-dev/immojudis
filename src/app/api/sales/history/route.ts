import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { getSaleHistory, saleHistoryQuerySchema } from "@/lib/sale-history";

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const input = saleHistoryQuerySchema.parse(Object.fromEntries(url.searchParams.entries()));
    const response = await getSaleHistory({ auth, input });

    return NextResponse.json(response, {
      headers: {
        "cache-control": "private, no-store",
        "x-immojudis-sale-history-row-count": String(response.items.length),
      },
    });
  } catch (error) {
    return apiRouteError(error, request, "sales.history", {
      fallbackMessage: "Historique indisponible",
    });
  }
}
