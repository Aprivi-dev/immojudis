import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { getMarketAnalytics, marketAnalyticsQuerySchema } from "@/lib/market-analytics";

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const input = marketAnalyticsQuerySchema.parse(Object.fromEntries(url.searchParams.entries()));
    const response = await getMarketAnalytics({ auth, input });

    return NextResponse.json(response, {
      headers: {
        "cache-control": "private, no-store",
        "x-immojudis-market-sample-size": String(response.summary.sampleSize),
      },
    });
  } catch (error) {
    return apiRouteError(error, request, "market-analytics", {
      fallbackMessage: "Analyse de marché indisponible",
    });
  }
}
