import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { getValuationBacktest, valuationBacktestQuerySchema } from "@/lib/valuation-backtest";

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const input = valuationBacktestQuerySchema.parse(
      Object.fromEntries(url.searchParams.entries()),
    );
    const response = await getValuationBacktest({ auth, input });

    return NextResponse.json(response, {
      headers: {
        "cache-control": "private, no-store",
        "x-immojudis-backtest-tests": String(response.backtest.summary.usableTests),
      },
    });
  } catch (error) {
    return apiRouteError(error, request, "valuation-backtest", {
      fallbackMessage: "Backtest de valorisation indisponible",
    });
  }
}
