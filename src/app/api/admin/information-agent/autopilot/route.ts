import {
  adminAutopilotActionSchema,
  getAdminAutopilotView,
  runAdminAutopilotAction,
} from "@/lib/admin-information-agent-autopilot";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/** État du pilote automatique, déjà mis en forme (mode, compteurs, contrôle de préparation, journal). */
export const GET = adminRoute(
  {
    scope: "admin.information-agent.autopilot.read",
    fallbackMessage: "Pilote automatique indisponible",
    guard: "admin",
  },
  async (_request, { authToken }) => getAdminAutopilotView(authToken),
);

/** Mode, réglages, arrêt d'urgence, attestation d'AIPD : toujours journalisés, motif obligatoire. */
export const POST = adminRoute(
  {
    scope: "admin.information-agent.autopilot.write",
    fallbackMessage: "Pilote automatique non modifié",
    guard: "admin",
  },
  async (request, { authToken }) => {
    const input = adminAutopilotActionSchema.parse(await request.json());
    return runAdminAutopilotAction({ authToken, input });
  },
);
