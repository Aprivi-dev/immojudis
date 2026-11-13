import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { adminSignupListQuerySchema, listAdminSignups } from "@/lib/admin-signups";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/**
 * Liste et recherche des inscrits. En POST : la recherche (adresse ou nom) voyage dans le corps JSON,
 * jamais dans l'URL, que les journaux de requêtes de l'hébergeur conservent.
 */
export const POST = adminRoute(
  { scope: "admin.signups.search", fallbackMessage: "Erreur admin inscriptions" },
  async (request) => {
    // Le jeton d'abord : sans session, la réponse est 401, que le corps soit valide ou non.
    const authToken = bearerTokenFromRequest(request);
    const query = adminSignupListQuerySchema.parse(await request.json());
    return listAdminSignups(authToken, query);
  },
);
