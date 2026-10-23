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
 * et une case « entretien » non cochée, proposée seulement quand l'identité de l'éditeur (nom et
 * email de contact) est renseignée (`offerOpeningInterviewAvailable`). Même règle que le consentement ci-dessus : le texte et la
 * version changent ensemble, la version est conservée avec les réponses et la route refuse une
 * requête qui en cite une autre.
 */
export const OFFER_OPENING_SURVEY_VERSION = "2026-10-28.2";

export const OFFER_OPENING_SURVEY_INTRO =
  "Aidez-nous à préparer l’offre : trois questions, toutes facultatives. Vos réponses n’ont aucun effet sur votre demande et sont effacées avec elle.";

export const OFFER_OPENING_SURVEY_PROFILES = [
  { value: "particulier", label: "Particulier" },
  { value: "marchand_de_biens", label: "Marchand de biens" },
  { value: "avocat", label: "Avocat" },
  { value: "autre", label: "Autre" },
] as const;

export type OfferOpeningSurveyProfile = (typeof OFFER_OPENING_SURVEY_PROFILES)[number]["value"];

/** Libellé du bouton d'envoi des réponses : le retrait par décochage prend effet à ce clic. */
export const OFFER_OPENING_SURVEY_SUBMIT_LABEL = "Enregistrer mes réponses";

/**
 * La case « entretien » n'est proposée que si le responsable du traitement et l'adresse de contact
 * (qui reçoit les demandes d'effacement) sont réellement renseignés ; sinon `legalValue()` afficherait
 * « À renseigner avant commercialisation » dans une information de consentement. Le serveur applique
 * la même règle : il refuse un accord à l'entretien quand la case n'est pas affichée.
 */
export function offerOpeningInterviewAvailable(publisher: {
  entityName: string | null;
  contactEmail: string | null;
}): boolean {
  return Boolean(publisher.entityName?.trim()) && Boolean(publisher.contactEmail?.trim());
}

/** Libellé de la case, jamais cochée par défaut. */
export const OFFER_OPENING_INTERVIEW_TEXT =
  "J’accepte d’être contacté une fois par email pour un entretien d’environ 45 minutes";
export const OFFER_OPENING_INTERVIEW_HELP =
  "Nous vous écrirons une seule fois, à l’adresse de votre compte, pour convenir d’un créneau. Cette case est facultative : elle n’a aucun effet sur votre demande.";

/** Durées annoncées avec la case « entretien » : à tenir dans l'étude (voir le texte ci-dessous). */
export const OFFER_OPENING_INTERVIEW_RECORDING_RETENTION_DAYS = 30;
export const OFFER_OPENING_INTERVIEW_NOTES_RETENTION_MONTHS = 12;

/**
 * Information donnée avec la case « entretien » (finalité, responsable, enregistrement, retrait, droits).
 * Le texte et OFFER_OPENING_SURVEY_VERSION changent ensemble. Il renvoie à la politique de
 * confidentialité sans la répéter : le responsable du traitement et l'adresse de contact viennent
 * des variables d'identité de l'éditeur (`publicLegalPublisher`, `legalValue`), comme dans la
 * politique elle-même.
 */
export function offerOpeningInterviewNotice(input: {
  controller: string;
  contactEmail: string;
}): string[] {
  return [
    "Objectif : comprendre comment vous choisissez les ventes que vous étudiez, pour améliorer l’offre Analyse.",
    `Responsable du traitement : ${input.controller}. Base : votre accord, donné par cette case.`,
    `Enregistrement : aucun sans votre accord exprès, demandé au début de l’entretien. Refuser l’enregistrement n’a aucune conséquence. Si vous l’acceptez, il ne sert qu’à rédiger les notes et il est supprimé au plus tard ${OFFER_OPENING_INTERVIEW_RECORDING_RETENTION_DAYS} jours après l’entretien. Les notes sont conservées ${OFFER_OPENING_INTERVIEW_NOTES_RETENTION_MONTHS} mois au plus.`,
    `Retrait : à tout moment, en décochant la case (le retrait prend effet après un clic sur « ${OFFER_OPENING_SURVEY_SUBMIT_LABEL} ») ou en retirant votre demande. Pour faire effacer les notes ou l’enregistrement d’un entretien déjà passé, écrivez à ${input.contactEmail}.`,
    "Vos droits (accès, rectification, effacement, retrait) et la possibilité de saisir la CNIL sont détaillés dans la politique de confidentialité.",
  ];
}
