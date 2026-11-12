import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { assertFeatureEntitlement } from "@/lib/entitlements.server";
import { professionalPilotSaveSchema, saveProfessionalPilot } from "@/lib/sale-workspaces";

export const PUT = apiRoute(
  {
    scope: "sale-workspace.professional-pilot",
    fallbackMessage: "Enregistrement impossible",
    emptyBody: { workspace: null },
  },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await assertFeatureEntitlement(
      auth,
      "workspace.audienceTracking",
      "Espace de suivi réservé à l’offre Analyse.",
    );
    const input = professionalPilotSaveSchema.parse(await request.json());
    return saveProfessionalPilot({ auth, input });
  },
);
