import {
  listAdminRecentAutoPublications,
  recentAutoPublicationsQuerySchema,
} from "@/lib/admin-information-agent-auto-publication";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/** Page suivante des publications automatiques des 30 derniers jours (onglet Réponses, « Afficher les suivantes »). */
export const GET = adminRoute(
  {
    scope: "admin.information-agent.auto-publication.published",
    fallbackMessage: "Publications automatiques indisponibles",
    guard: "admin",
  },
  async (request, { authToken }) => {
    const { offset } = recentAutoPublicationsQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    return listAdminRecentAutoPublications(authToken, offset);
  },
);
