import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { assertAdminAuth } from "@/lib/admin-auth.server";
import { adminRoute } from "@/lib/admin-route-deadline";
import { previewAdminInformationAgentMission } from "@/lib/information-agent/preview";
import { informationAgentPreviewSchema } from "@/lib/information-agent/schemas";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/**
 * Aperçu exact de l'e-mail d'une mission (HTML et texte, pied RGPD, liens) et motifs qui
 * bloqueraient l'envoi. Ne modifie rien et n'envoie rien : l'empreinte rendue est exigée par
 * « Valider et envoyer », qui reste la seule action d'envoi.
 */
export const POST = adminRoute(
  {
    scope: "admin.information-agent.missions.preview",
    fallbackMessage: "Aperçu de la mission indisponible",
  },
  async (request) => {
    const authToken = bearerTokenFromRequest(request);
    const input = informationAgentPreviewSchema.parse(await request.json());
    const auth = await assertAdminAuth(authToken);
    return previewAdminInformationAgentMission({ auth, input });
  },
);
