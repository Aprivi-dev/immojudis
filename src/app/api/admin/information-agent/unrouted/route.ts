import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminInformationAgentUnroutedActionSchema,
  adminInformationAgentUnroutedQuerySchema,
  listAdminInformationAgentUnrouted,
  runAdminInformationAgentUnroutedAction,
} from "@/lib/admin-information-agent";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/** Messages reçus sans dossier ouvert, encore à traiter (`offset` / `limit`, 50 par défaut). */
export const GET = adminRoute(
  {
    scope: "admin.information-agent.unrouted.read",
    fallbackMessage: "Messages sans dossier indisponibles",
  },
  async (request) => {
    const input = adminInformationAgentUnroutedQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    return listAdminInformationAgentUnrouted(bearerTokenFromRequest(request), input);
  },
);

/** « Marquer comme traité » : la seule action ; aucun envoi, aucune extraction. */
export const POST = adminRoute(
  {
    scope: "admin.information-agent.unrouted.action",
    fallbackMessage: "Message non marqué comme traité",
  },
  async (request) => {
    const authToken = bearerTokenFromRequest(request);
    const input = adminInformationAgentUnroutedActionSchema.parse(await request.json());
    return runAdminInformationAgentUnroutedAction({ authToken, input });
  },
);
