import { getAdminOfferOpeningInterviewees } from "@/lib/admin-offer-opening-survey";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/**
 * Liste des personnes qui ont accepté un entretien (questionnaire de la liste d'attente) : lecture
 * seule, administrateur seulement, jamais mise en cache. Elle porte des adresses email : elle n'est
 * pas dans la réponse de « Pilotage » et ne se charge qu'à la demande de l'administrateur.
 */
export const GET = adminRoute(
  {
    scope: "admin.offer-opening-interviewees.read",
    fallbackMessage: "Liste des entretiens indisponible",
    guard: "admin",
  },
  async (_request, { authToken }) => getAdminOfferOpeningInterviewees(authToken),
);
