import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  createSaleAnalysisSet,
  listSaleAnalysisSets,
  saleAnalysisSetInputSchema,
} from "@/lib/sale-analysis-sets";

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const includeArchived = url.searchParams.get("includeArchived") === "true";
    const response = await listSaleAnalysisSets({ auth, includeArchived });

    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiRouteError(error, request, "sale-analysis-sets", {
      fallbackMessage: "Analyses multi-biens indisponibles",
      extra: { sets: [] },
    });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = saleAnalysisSetInputSchema.parse(await request.json());
    const response = await createSaleAnalysisSet({ auth, input });

    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiRouteError(error, request, "sale-analysis-sets", {
      fallbackMessage: "Création d'analyse impossible",
      extra: { set: null },
    });
  }
}
