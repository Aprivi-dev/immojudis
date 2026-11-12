import { NextResponse } from "next/server";
import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { getSaleHistory, saleHistoryQuerySchema } from "@/lib/sale-history";

export const GET = apiRoute(
  { scope: "sales.history", fallbackMessage: "Historique indisponible" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const input = saleHistoryQuerySchema.parse(Object.fromEntries(url.searchParams.entries()));
    const response = await getSaleHistory({ auth, input });

    return NextResponse.json(response, {
      headers: { "x-immojudis-sale-history-row-count": String(response.items.length) },
    });
  },
);
