import { apiRoute } from "@/lib/api-route";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { disableSaleComparisonShare, enableSaleComparisonShare } from "@/lib/sale-analysis-sets";

const setIdSchema = z.string().guid();

const SHARE_DISABLED = { enabled: false, url: null, expiresAt: null };

export const POST = apiRoute<{ id: string }>(
  {
    scope: "sale-analysis-sets.id.share",
    fallbackMessage: "Partage impossible",
    emptyBody: SHARE_DISABLED,
  },
  async (request, { params }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    return enableSaleComparisonShare({
      auth,
      setId: setIdSchema.parse(params.id),
      origin: new URL(request.url).origin,
    });
  },
);

export const DELETE = apiRoute<{ id: string }>(
  {
    scope: "sale-analysis-sets.id.share",
    fallbackMessage: "Désactivation impossible",
    emptyBody: SHARE_DISABLED,
  },
  async (request, { params }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    return disableSaleComparisonShare({ auth, setId: setIdSchema.parse(params.id) });
  },
);
