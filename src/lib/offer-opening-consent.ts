// Kept free of zod and server imports: client components (and the home page,
// through `client-billing`) only need these strings.

/**
 * Wording shown next to the "Me prévenir de l'ouverture" button. Change the text
 * and the version together: the version is stored with the timestamp as proof of
 * what the user agreed to, and the server refuses a request that echoes another one.
 */
export const OFFER_OPENING_CONSENT_VERSION = "2026-10-21";
export const OFFER_OPENING_CONSENT_TEXT =
  "En cliquant, vous demandez à recevoir un seul email à l’ouverture de l’offre Analyse. Vous pouvez retirer cette demande à tout moment.";
/** Shown once the request is stored; the consent itself is OFFER_OPENING_CONSENT_TEXT. */
export const OFFER_OPENING_REQUESTED_TEXT =
  "Votre demande est enregistrée : nous vous écrirons une seule fois à l’ouverture de l’offre Analyse.";
