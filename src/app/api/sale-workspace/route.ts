import { apiRoute } from "@/lib/api-route";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  getSaleWorkspace,
  saleWorkspaceInputSchema,
  upsertSaleWorkspace,
} from "@/lib/sale-workspaces";
import { assertFeatureEntitlement } from "@/lib/property-reports";

const saleIdSchema = z.string().guid();

export const GET = apiRoute(
  {
    scope: "sale-workspace",
    fallbackMessage: "Dossier de suivi indisponible",
    emptyBody: { workspace: null },
  },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await assertFeatureEntitlement(
      auth,
      "workspace.audienceTracking",
      "Espace de suivi réservé à l’offre Analyse.",
    );
    const url = new URL(request.url);
    const saleId = saleIdSchema.parse(url.searchParams.get("saleId"));
    return getSaleWorkspace({ auth, saleId });
  },
);

export const PUT = apiRoute(
  {
    scope: "sale-workspace",
    fallbackMessage: "Dossier de suivi impossible",
    emptyBody: { workspace: null },
  },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await assertFeatureEntitlement(
      auth,
      "workspace.audienceTracking",
      "Espace de suivi réservé à l’offre Analyse.",
    );
    const input = saleWorkspaceInputSchema.parse(await request.json());
    return upsertSaleWorkspace({ auth, input });
  },
);
