import {
  attestAdminInformationAgentRoundtrip,
  getAdminInformationAgentOperations,
} from "@/lib/admin-information-agent-operations";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/** Indicateurs d'exploitation (30 jours) et état de la vérification de l'aller-retour, déjà mis en forme. */
export const GET = adminRoute(
  {
    scope: "admin.information-agent.operations.read",
    fallbackMessage: "Indicateurs d'exploitation indisponibles",
    guard: "admin",
  },
  async (_request, { authToken }) => getAdminInformationAgentOperations(authToken),
);

/** « J'ai vérifié l'aller-retour réel » : enregistre la date. N'envoie rien. */
export const POST = adminRoute(
  {
    scope: "admin.information-agent.operations.attest",
    fallbackMessage: "Vérification non enregistrée",
    guard: "admin",
  },
  async (_request, { authToken }) => attestAdminInformationAgentRoundtrip(authToken),
);
