import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  getAdminLaunchOfferEnd,
  launchOfferEndActionSchema,
  sendLaunchOfferEndBatch,
  sendLaunchOfferEndTest,
  setAdminLaunchOfferEnd,
} from "@/lib/admin-launch-offer-end";
import { withAdminDeadline } from "@/lib/admin-route-deadline";
import { adminErrorResponse } from "@/lib/api-route-errors";

// Délai maximal des routes admin : 30 s. L'envoi par lots s'arrête de lui-même avant (budget de temps).
export const maxDuration = 30;

const NO_STORE = { "cache-control": "private, no-store" };

/** Date de fin annoncée, comptes concernés, état de l'envoi et aperçu du message. */
async function handleGET(request: Request) {
  try {
    const state = await getAdminLaunchOfferEnd({ authToken: bearerTokenFromRequest(request) });
    return NextResponse.json(state, { headers: NO_STORE });
  } catch (error) {
    return adminErrorResponse(error, { fallbackMessage: "Préavis de fin d’offre indisponible" });
  }
}

/**
 * `{ action: "set-date", endsOn }` : enregistre la date annoncée (ne coupe rien) ;
 * `{ action: "test" }` : essai à l'administrateur ;
 * `{ action: "send", endsOn, confirm: true }` : un lot, sur action explicite.
 */
async function handlePOST(request: Request) {
  try {
    const authToken = bearerTokenFromRequest(request);
    const input = launchOfferEndActionSchema.parse(await request.json());
    if (input.action === "set-date") {
      await setAdminLaunchOfferEnd({ authToken, endsOn: input.endsOn });
      return NextResponse.json(await getAdminLaunchOfferEnd({ authToken }), { headers: NO_STORE });
    }
    if (input.action === "test") {
      return NextResponse.json(await sendLaunchOfferEndTest({ authToken }), { headers: NO_STORE });
    }
    return NextResponse.json(
      await sendLaunchOfferEndBatch({ authToken, endsOn: input.endsOn, limit: input.limit }),
      { headers: NO_STORE },
    );
  } catch (error) {
    return adminErrorResponse(error, { fallbackMessage: "Action non effectuée" });
  }
}

export const GET = withAdminDeadline(handleGET);
export const POST = withAdminDeadline(handlePOST);
