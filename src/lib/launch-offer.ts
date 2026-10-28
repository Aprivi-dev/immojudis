/**
 * Essai gratuit de 7 jours à l'inscription (décision du propriétaire du 25/10/2026) : un compte
 * gratuit bénéficie de l'offre Analyse pendant 7 jours à compter de la confirmation de son adresse
 * email, une fois par personne, sans carte bancaire ; ensuite il revient à Découverte, sauf
 * abonnement. Il remplace l'offre de lancement sans durée (19/10/2026), dont il reprend le
 * mécanisme et les noms internes (`launch_offer`, `launchOffer`, `LAUNCH_OFFER_*`).
 *
 * Source de vérité : la base de données. L'interrupteur `app_private.launch_offer` (« l'essai est
 * ouvert ») est lu par le RPC `get_launch_offer_status` (voir `launch-offer.server.ts`, cache de
 * 30 s) et par le navigateur avec `GET /api/launch-offer` ; la fin de l'essai d'un compte vient de
 * `app_private.signup_trial_ends_at` (`PlanEntitlements.trialEndsAt` / `trialEndedAt`). Aucune
 * variable d'environnement : un second réglage pourrait diverger de la base.
 *
 * Module pur, sans import serveur : les textes ci-dessous sont les seuls à utiliser partout où
 * l'essai est présenté. L'interrupteur seul ne dit pas si un compte connecté est en essai : les
 * textes pour un compte (`LAUNCH_OFFER_ACCOUNT_TEXT`) énoncent donc la règle, et seuls les écrans qui
 * lisent les droits du compte disent « jusqu'au … » ou « votre essai est terminé ».
 */

import { ANALYSIS_TRIAL_DAYS } from "@/lib/analysis-offer";

/** Nom court de l'essai, pour les badges et les titres. */
export const LAUNCH_OFFER_LABEL = `Essai gratuit de ${ANALYSIS_TRIAL_DAYS} jours`;

/**
 * Résumé d'une ligne pour un visiteur, toujours accompagné du texte complet sur la même page ou d'un
 * lien (bannière repliable de /sales, premier écran de l'accueil).
 */
/** Sous le bouton d'inscription de l'accueil et de l'annonce exemple, pendant l'essai. */
export const HOME_TRIAL_NOTE = `${ANALYSIS_TRIAL_DAYS} jours d’accès à l’offre Analyse, sans carte bancaire.`;

export const LAUNCH_OFFER_SHORT_TEXT = `Inscription gratuite : ${ANALYSIS_TRIAL_DAYS} jours d’accès à l’offre Analyse, sans carte bancaire`;

/**
 * La ligne visible en tête du formulaire d'inscription sur téléphone, à la place du texte complet
 * (les conditions sont dans un repli « Conditions de l'essai gratuit », voir
 * `LAUNCH_OFFER_DURATION_TEXT`).
 */
export const LAUNCH_OFFER_SIGNUP_LINE = `${LAUNCH_OFFER_SHORT_TEXT} ni prélèvement ensuite.`;

/**
 * Règles de l'essai, reprises dans l'article « Essai gratuit à l'inscription » des CGV
 * (`src/routes/conditions-generales.tsx`, qui les écrit en toutes lettres : le texte juridique est
 * ancré par empreinte). La clause de retrait anticipé reprend la relecture juridique du 20/10/2026.
 *
 * La fin de l'essai : retour à Découverte, offre payante ensuite, retrait anticipé limité. Des
 * constantes, sans appel au chargement du module : `client-billing` (chargé sur toutes les pages)
 * importe `parseLaunchOfferResponse` d'ici, et le reste du module doit pouvoir être écarté du paquet.
 */
const TRIAL_END_RULES =
  "À son terme, votre compte revient à l’offre Découverte, gratuite et sans limite de durée : rien ne devient payant automatiquement. L’offre Analyse est ensuite proposée sur abonnement payant ; son tarif figure sur la page Offres. L’essai peut être retiré plus tôt, sans préavis, en cas d’abus ou d’impératif technique ou juridique.";

export const LAUNCH_OFFER_DURATION_TEXT = `L’essai commence à la confirmation de votre adresse email, dure ${ANALYSIS_TRIAL_DAYS} jours et n’est proposé qu’une fois par personne. ${TRIAL_END_RULES}`;

/** Ce que deviennent les données à la fin de l'essai. */
export const LAUNCH_OFFER_DATA_TEXT =
  "Vos données (favoris, alertes, rapports enregistrés) restent conservées tant que votre compte existe et dans les durées de la politique de confidentialité. Elles redeviennent accessibles avec l’offre Analyse.";

/**
 * Mention à un compte connecté : la règle de l'essai, vraie que le compte soit en essai, après son
 * essai ou sans droit à l'essai. Son état à lui est dans Mon compte (`signupTrialStatusText`).
 */
export const LAUNCH_OFFER_ACCOUNT_TEXT = `Essai gratuit : le premier compte confirmé de chaque personne bénéficie de l’offre Analyse pendant ${ANALYSIS_TRIAL_DAYS} jours à compter de la confirmation de son adresse email, sans carte bancaire. ${TRIAL_END_RULES}`;

/** Mention à un visiteur non connecté (appels à l'inscription). */
export const LAUNCH_OFFER_VISITOR_TEXT = `Inscrivez-vous gratuitement : une fois votre adresse email confirmée, votre compte bénéficie de l’offre Analyse pendant ${ANALYSIS_TRIAL_DAYS} jours (un essai par personne), sans carte bancaire. ${TRIAL_END_RULES}`;

let trialDateFormat: Intl.DateTimeFormat | null = null;

/** « 1er novembre 2026 à 14:05 », heure de Paris. */
export function signupTrialDateLabel(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  trialDateFormat ??= new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Paris",
  });
  return trialDateFormat.format(time).replace(/^1 /, "1er ");
}

/** Compte confirmé auquel la base refuse l'essai (pas le premier de son adresse, adresse jetable). */
export const SIGNUP_TRIAL_DENIED_TEXT =
  "L’essai gratuit n’a pas été accordé à ce compte : il est réservé au premier compte confirmé de chaque personne et n’est pas ouvert aux adresses jetables. Votre compte reste en offre Découverte. Si vous pensez qu’il s’agit d’une erreur, écrivez-nous depuis la page Contact.";

/**
 * État de l'essai d'un compte dont on connaît les droits (Mon compte) : en cours jusqu'à telle date,
 * terminé, prolongé par l'administrateur, ou refusé. `null` quand le compte n'a pas d'essai connu (abonné, état non lu).
 */
export function signupTrialStatusText({
  trialEndsAt,
  trialEndedAt,
  trialDenied,
  trialExtension,
}: {
  trialEndsAt?: string | null;
  trialEndedAt?: string | null;
  trialDenied?: boolean;
  /** L'essai a été prolongé par l'administrateur : `trialEndsAt` est la fin de la prolongation. */
  trialExtension?: boolean;
}): string | null {
  if (trialEndsAt && trialExtension) {
    return `Essai gratuit prolongé jusqu’au ${signupTrialDateLabel(trialEndsAt)} ; rien ne devient payant automatiquement. À son terme, votre compte revient à l’offre Découverte, gratuite.`;
  }
  if (trialEndsAt) {
    return `Essai gratuit de l’offre Analyse jusqu’au ${signupTrialDateLabel(trialEndsAt)}. À son terme, votre compte revient à l’offre Découverte, gratuite : rien ne devient payant automatiquement.`;
  }
  if (trialEndedAt) {
    return `Votre essai gratuit de l’offre Analyse s’est terminé le ${signupTrialDateLabel(trialEndedAt)} : votre compte est revenu à l’offre Découverte. Pour continuer avec l’offre Analyse, il faudra y souscrire ; l’état de l’abonnement est indiqué ci-dessous.`;
  }
  if (trialDenied) return SIGNUP_TRIAL_DENIED_TEXT;
  return null;
}

export type LaunchOfferAudience = "account" | "visitor";

/** La mention qui convient : compte connecté ou visiteur. */
export function launchOfferText(audience: LaunchOfferAudience): string {
  return audience === "account" ? LAUNCH_OFFER_ACCOUNT_TEXT : LAUNCH_OFFER_VISITOR_TEXT;
}

// Lecture de `GET /api/launch-offer`, dans un module à part : `client-billing`, chargé sur toutes
// les pages, l'importe sans tirer les textes de l'essai ni `analysis-offer` dans le paquet commun.
export {
  LAUNCH_OFFER_CACHE_SECONDS,
  parseLaunchOfferResponse,
  type LaunchOfferResponse,
} from "@/lib/launch-offer-response";
