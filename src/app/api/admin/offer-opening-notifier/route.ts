import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  getOfferOpeningAudience,
  offerOpeningNotifierActionSchema,
  sendOfferOpeningBatch,
  sendOfferOpeningTest,
} from "@/lib/admin-offer-opening-notifier";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts). L'envoi par lots
// s'arrête de lui-même avant (budget de temps) et se relance pour le reste.
export const maxDuration = 30;

/** Destinataires actifs, configuration d'envoi et aperçu du message. */
export const GET = adminRoute(
  { scope: "admin.offer-opening-notifier.read", fallbackMessage: "Liste d’attente indisponible" },
  async (request) => getOfferOpeningAudience({ authToken: bearerTokenFromRequest(request) }),
);

/** `{ action: "test" }` : envoi d'essai à l'administrateur ; `{ action: "send", confirm: true }` : un lot. */
export const POST = adminRoute(
  {
    scope: "admin.offer-opening-notifier.send",
    fallbackMessage: "Envoi non effectué",
    guard: "admin",
  },
  async (request, { authToken }) => {
    const input = offerOpeningNotifierActionSchema.parse(await request.json());
    if (input.action === "test") return sendOfferOpeningTest({ authToken });
    return sendOfferOpeningBatch({ authToken, limit: input.limit });
  },
);
