import { adminSignupListQuerySchema, listAdminSignups } from "@/lib/admin-signups";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/**
 * Liste et recherche des inscrits. En POST : la recherche (adresse ou nom) voyage dans le corps JSON,
 * jamais dans l'URL, que les journaux de requêtes de l'hébergeur conservent.
 */
export const POST = adminRoute(
  { scope: "admin.signups.search", fallbackMessage: "Erreur admin inscriptions", guard: "admin" },
  async (request, { authToken }) => {
    const query = adminSignupListQuerySchema.parse(await request.json());
    return listAdminSignups(authToken, query);
  },
);
