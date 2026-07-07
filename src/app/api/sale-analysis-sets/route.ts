import { NextResponse } from "next/server";
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
    const message = error instanceof Error ? error.message : "Analyses multi-biens indisponibles";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réservée")
        ? 403
        : 400;
    return NextResponse.json({ sets: [], error: message }, { status });
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
    const message = error instanceof Error ? error.message : "Création d'analyse impossible";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réservée")
        ? 403
        : 400;
    return NextResponse.json({ set: null, error: message }, { status });
  }
}
