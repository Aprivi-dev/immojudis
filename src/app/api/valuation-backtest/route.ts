import { NextResponse } from "next/server";
import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { getValuationBacktest, valuationBacktestQuerySchema } from "@/lib/valuation-backtest";

export const GET = apiRoute(
  { scope: "valuation-backtest", fallbackMessage: "Backtest de valorisation indisponible" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const input = valuationBacktestQuerySchema.parse(
      Object.fromEntries(url.searchParams.entries()),
    );
    const response = await getValuationBacktest({ auth, input });

    return NextResponse.json(response, {
      headers: { "x-immojudis-backtest-tests": String(response.backtest.summary.usableTests) },
    });
  },
);
