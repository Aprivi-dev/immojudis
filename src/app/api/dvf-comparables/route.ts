import { NextResponse } from "next/server";
import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { dvfComparablesQuerySchema, getDvfComparables } from "@/lib/dvf-comparables";

export const GET = apiRoute(
  { scope: "dvf-comparables", fallbackMessage: "Comparables DVF indisponibles" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "dvf-comparables",
      ...RATE_LIMIT_POLICIES.compute,
    });
    const url = new URL(request.url);
    const input = dvfComparablesQuerySchema.parse(Object.fromEntries(url.searchParams.entries()));
    const response = await getDvfComparables({ auth, input });

    return NextResponse.json(response, {
      headers: { "x-immojudis-dvf-sample-size": String(response.analysis.sampleSize) },
    });
  },
);
