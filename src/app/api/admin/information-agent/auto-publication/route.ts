import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminAutoPublicationActionSchema,
  getAdminAutoPublicationView,
  runAdminAutoPublicationAction,
} from "@/lib/admin-information-agent-auto-publication";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/** Mode de la publication automatique (arrêt, simulation ; automatique verrouillé) et changements récents. */
export const GET = adminRoute(
  {
    scope: "admin.information-agent.auto-publication.read",
    fallbackMessage: "Publication automatique indisponible",
  },
  async (request) => getAdminAutoPublicationView(bearerTokenFromRequest(request)),
);

/** Changement de mode ou arrêt d'urgence (administrateur, tracé en base). */
export const POST = adminRoute(
  {
    scope: "admin.information-agent.auto-publication.write",
    fallbackMessage: "Publication automatique non modifiée",
    guard: "admin",
  },
  async (request, { authToken }) => {
    const input = adminAutoPublicationActionSchema.parse(await request.json());
    return runAdminAutoPublicationAction({ authToken, input });
  },
);
