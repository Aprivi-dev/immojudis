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

/**
 * Liste d'attente qualifiée : trois questions facultatives posées une fois la demande enregistrée,
 * et une case « entretien » non cochée. Même règle que le consentement ci-dessus : le texte et la
 * version changent ensemble, la version est conservée avec les réponses et la route refuse une
 * requête qui en cite une autre.
 */
export const OFFER_OPENING_SURVEY_VERSION = "2026-10-28";

export const OFFER_OPENING_SURVEY_INTRO =
  "Aidez-nous à préparer l’offre : trois questions, toutes facultatives. Vos réponses n’ont aucun effet sur votre demande et sont effacées avec elle.";

export const OFFER_OPENING_SURVEY_PROFILES = [
  { value: "particulier", label: "Particulier" },
  { value: "marchand_de_biens", label: "Marchand de biens" },
  { value: "avocat", label: "Avocat" },
  { value: "autre", label: "Autre" },
] as const;

export type OfferOpeningSurveyProfile = (typeof OFFER_OPENING_SURVEY_PROFILES)[number]["value"];

/** Libellé de la case, jamais cochée par défaut. */
export const OFFER_OPENING_INTERVIEW_TEXT = "J’accepte un entretien de 20 minutes";
export const OFFER_OPENING_INTERVIEW_HELP =
  "Nous vous écrirons à l’adresse de votre compte pour convenir d’un créneau. Vous pouvez retirer cet accord à tout moment en décochant la case, ou en retirant votre demande.";
