import { adminRoute } from "@/lib/admin-route-deadline";
import { getAdminSaleFeedbackBySale } from "@/lib/admin-sale-signal-feedback";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/**
 * Retours « Pas pertinent » par vente, signal et motif (90 jours) : de quoi corriger la fiche en cause.
 * Administrateur seulement, jamais mis en cache. Aucun compte dans la réponse.
 */
export const GET = adminRoute(
  {
    scope: "admin.sale-feedback.read",
    fallbackMessage: "Retours par vente indisponibles",
    guard: "admin",
  },
  async (_request, { authToken }) => getAdminSaleFeedbackBySale(authToken),
);
