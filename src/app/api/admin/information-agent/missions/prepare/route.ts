import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminInformationAgentCreateSchema,
  prepareAdminInformationAgentMissionForToken,
} from "@/lib/admin-information-agent";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/**
 * « Préparer » en un clic : brouillon (créé ou retrouvé) et aperçu exact dans la même réponse. N'envoie
 * rien : l'envoi reste le PATCH `approve_and_send`, avec l'empreinte de l'aperçu et la confirmation.
 */
export const POST = adminRoute(
  {
    scope: "admin.information-agent.missions.prepare",
    fallbackMessage: "Préparation de la mission impossible",
  },
  async (request) => {
    const authToken = bearerTokenFromRequest(request);
    const input = adminInformationAgentCreateSchema.parse(await request.json());
    return prepareAdminInformationAgentMissionForToken({ authToken, input });
  },
);
