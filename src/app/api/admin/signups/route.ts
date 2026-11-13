import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { adminTrialExtensionInputSchema, extendAdminSignupTrials } from "@/lib/admin-signups";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/**
 * Prolongation de l'essai de comptes choisis. La lecture de la liste est dans `./search` (POST, corps
 * JSON) : une recherche par adresse ne doit pas passer dans l'URL, donc dans les journaux
 * d'infrastructure.
 */
export const POST = adminRoute(
  { scope: "admin.signups.extend-trial", fallbackMessage: "Erreur admin prolongation d'essai" },
  async (request) => {
    // Le jeton d'abord : sans session, la réponse est 401, que le corps soit valide ou non.
    const authToken = bearerTokenFromRequest(request);
    const input = adminTrialExtensionInputSchema.parse(await request.json());
    return extendAdminSignupTrials({ authToken, input });
  },
);
