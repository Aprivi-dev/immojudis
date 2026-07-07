import { NextResponse } from "next/server";
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
    const message = error instanceof Error ? error.message : "Historique indisponible";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réservé")
        ? 403
        : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
