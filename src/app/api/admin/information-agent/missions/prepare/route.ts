import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { assertAdminAuth } from "@/lib/admin-auth.server";
import { adminRoute } from "@/lib/admin-route-deadline";
import { prepareAdminInformationAgentDraft } from "@/lib/information-agent/prepare";
import { informationAgentCreateSchema } from "@/lib/information-agent/schemas";

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
    const input = informationAgentCreateSchema.parse(await request.json());
    const auth = await assertAdminAuth(authToken);
    return prepareAdminInformationAgentDraft({ auth, input });
  },
);
