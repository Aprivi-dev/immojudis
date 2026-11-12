import { NextResponse } from "next/server";
import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { getMarketAnalytics, marketAnalyticsQuerySchema } from "@/lib/market-analytics";

export const GET = apiRoute(
  { scope: "market-analytics", fallbackMessage: "Analyse de marché indisponible" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const input = marketAnalyticsQuerySchema.parse(Object.fromEntries(url.searchParams.entries()));
    const response = await getMarketAnalytics({ auth, input });

    return NextResponse.json(response, {
      headers: { "x-immojudis-market-sample-size": String(response.summary.sampleSize) },
    });
  },
);
