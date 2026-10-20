import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { withAdminDeadline } from "@/lib/admin-route-deadline";
import {
  getOfferOpeningAudience,
  offerOpeningNotifierActionSchema,
  sendOfferOpeningBatch,
  sendOfferOpeningTest,
} from "@/lib/admin-offer-opening-notifier";
import { adminErrorResponse } from "@/lib/api-route-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts). L'envoi par lots
// s'arrête de lui-même avant (budget de temps) et se relance pour le reste.
export const maxDuration = 30;

const NO_STORE = { "cache-control": "private, no-store" };

/** Destinataires actifs, configuration d'envoi et aperçu du message. */
async function handleGET(request: Request) {
  try {
    const audience = await getOfferOpeningAudience({
      authToken: bearerTokenFromRequest(request),
    });
    return NextResponse.json(audience, { headers: NO_STORE });
  } catch (error) {
    return adminErrorResponse(error, { fallbackMessage: "Liste d’attente indisponible" });
  }
}

/** `{ action: "test" }` : envoi d'essai à l'administrateur ; `{ action: "send", confirm: true }` : un lot. */
async function handlePOST(request: Request) {
  try {
    const authToken = bearerTokenFromRequest(request);
    const input = offerOpeningNotifierActionSchema.parse(await request.json());
    if (input.action === "test") {
      return NextResponse.json(await sendOfferOpeningTest({ authToken }), { headers: NO_STORE });
    }
    return NextResponse.json(await sendOfferOpeningBatch({ authToken, limit: input.limit }), {
      headers: NO_STORE,
    });
  } catch (error) {
    return adminErrorResponse(error, { fallbackMessage: "Envoi non effectué" });
  }
}

export const GET = withAdminDeadline(handleGET);
export const POST = withAdminDeadline(handlePOST);
