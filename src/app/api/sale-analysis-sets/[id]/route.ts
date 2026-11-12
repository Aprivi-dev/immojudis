import { apiRoute } from "@/lib/api-route";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  deleteSaleAnalysisSet,
  saleAnalysisSetUpdateSchema,
  updateSaleAnalysisSet,
} from "@/lib/sale-analysis-sets";

const setIdSchema = z.string().guid();

export const PATCH = apiRoute<{ id: string }>(
  {
    scope: "sale-analysis-sets.id",
    fallbackMessage: "Mise à jour d'analyse impossible",
    emptyBody: { set: null },
  },
  async (request, { params }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const setId = setIdSchema.parse(params.id);
    const input = saleAnalysisSetUpdateSchema.parse(await request.json());
    return updateSaleAnalysisSet({ auth, setId, input });
  },
);

export const DELETE = apiRoute<{ id: string }>(
  { scope: "sale-analysis-sets.id", fallbackMessage: "Suppression d'analyse impossible" },
  async (request, { params }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const setId = setIdSchema.parse(params.id);
    return deleteSaleAnalysisSet({ auth, setId });
  },
);
