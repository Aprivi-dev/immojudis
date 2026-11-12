import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  createSaleAnalysisSet,
  listSaleAnalysisSets,
  saleAnalysisSetInputSchema,
} from "@/lib/sale-analysis-sets";

export const GET = apiRoute(
  {
    scope: "sale-analysis-sets",
    fallbackMessage: "Analyses multi-biens indisponibles",
    emptyBody: { sets: [] },
  },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const includeArchived = url.searchParams.get("includeArchived") === "true";
    return listSaleAnalysisSets({ auth, includeArchived });
  },
);

export const POST = apiRoute(
  {
    scope: "sale-analysis-sets",
    fallbackMessage: "Création d'analyse impossible",
    emptyBody: { set: null },
  },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = saleAnalysisSetInputSchema.parse(await request.json());
    return createSaleAnalysisSet({ auth, input });
  },
);
