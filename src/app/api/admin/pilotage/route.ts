import { getAdminActivation, unavailableActivation } from "@/lib/admin-activation";
import { getAdminBidCeilings, unavailableBidCeilings } from "@/lib/admin-bid-ceilings";
import {
  getAdminOfferOpeningSurvey,
  unavailableOfferOpeningSurvey,
} from "@/lib/admin-offer-opening-survey";
import { adminRoute } from "@/lib/admin-route-deadline";
import {
  getAdminPilotage,
  getAdminSaleReminderAccuracy,
  unavailableSaleReminderAccuracy,
} from "@/lib/admin-pilotage";
import {
  getAdminSaleSignalFeedback,
  unavailableSaleSignalFeedback,
} from "@/lib/admin-sale-signal-feedback";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/** Agrégats de la page « Pilotage » : administrateur seulement, jamais mis en cache. */
export const GET = adminRoute(
  { scope: "admin.pilotage.read", fallbackMessage: "Pilotage indisponible", guard: "admin" },
  async (_request, { authToken: token }) => {
    const now = new Date();
    // La mesure des rappels ne doit pas faire tomber le reste du pilotage : en cas d'échec, elle vaut
    // « non mesuré » (le contrôle du rôle administrateur est fait par `getAdminPilotage`).
    const [pilotage, saleReminders, signalFeedback, bidCeilings, offerOpeningSurvey, activation] =
      await Promise.all([
        getAdminPilotage(token, now),
        getAdminSaleReminderAccuracy(token, now).catch(() => {
          console.error("[admin-pilotage] mesure des fausses alertes des rappels indisponible");
          return unavailableSaleReminderAccuracy(now);
        }),
        // Même règle pour les retours « Utile » / « Pas pertinent » sur les signaux d'une vente.
        getAdminSaleSignalFeedback(token, now).catch(() => {
          console.error("[admin-pilotage] retours sur les signaux d'une vente indisponibles");
          return unavailableSaleSignalFeedback();
        }),
        // Et pour les estimations servies (plafonds d'enchère).
        getAdminBidCeilings(token, now).catch(() => {
          console.error("[admin-pilotage] plafonds d'enchère calculés indisponibles");
          return unavailableBidCeilings();
        }),
        // Et pour les réponses du questionnaire de la liste d'attente.
        getAdminOfferOpeningSurvey(token, now).catch(() => {
          console.error("[admin-pilotage] réponses du questionnaire d'ouverture indisponibles");
          return unavailableOfferOpeningSurvey();
        }),
        // Et pour l'activation (indépendante du déblocage) et le déblocage gratuit et les achats à
        // l'unité des comptes Découverte. Le site est déployé avant la migration 20261125100000 :
        // jusqu'à son application, la fonction de la base manque et ces deux cartes sont « non mesuré ».
        getAdminActivation(token, now).catch(() => {
          console.error(
            "[admin-pilotage] activation et déblocages des comptes Découverte indisponibles",
          );
          return unavailableActivation();
        }),
      ]);
    return {
      ...pilotage,
      saleReminders,
      signalFeedback,
      bidCeilings,
      offerOpeningSurvey,
      activation,
    };
  },
);
