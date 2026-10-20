/**
 * Offre de lancement : tant qu'elle est active, tout compte gratuit bénéficie des avantages de
 * l'offre Analyse (demande du propriétaire, 19/10/2026 : la société n'est pas créée et Stripe n'est
 * pas configuré, le paiement reste fermé).
 *
 * Source de vérité : la base de données (`app_private.launch_offer`, lue par
 * `app_private.launch_offer_active()`). Le serveur la lit par le RPC `get_launch_offer_status`
 * (voir `launch-offer.server.ts`, cache de 30 s) et le navigateur par `GET /api/launch-offer`.
 * Aucune variable d'environnement : un second réglage pourrait diverger de la base.
 *
 * Module pur, sans import serveur : les textes ci-dessous sont les seuls à utiliser partout où le
 * surclassement est présenté (bandeau de /offres, inscription, onboarding, /compte, lignes d'accès
 * des appels à l'inscription). Les autres chantiers les réutilisent, ils ne les recopient pas.
 */

/** Nom court de l'offre, pour les badges et les titres. */
export const LAUNCH_OFFER_LABEL = "Offre de lancement";

/**
 * Durée de l'offre, formule de la relecture juridique du 20/10/2026 (à faire valider par un avocat,
 * comme tout ce fichier) : les avantages sont temporaires, finissent au plus tard au lancement
 * officiel, la fin est annoncée par email, et ils ne sont retirés plus tôt, sans préavis, que pour
 * abus ou impératif technique ou juridique. Reprise dans l'article « Offre de lancement » des CGV
 * (`src/routes/conditions-generales.tsx`, qui l'écrit en toutes lettres : le texte juridique est
 * ancré par empreinte).
 */
export const LAUNCH_OFFER_DURATION_TEXT =
  "Ces avantages sont temporaires et prendront fin au plus tard au lancement officiel du site. Nous vous prévenons par email avant leur fin ; ils peuvent toutefois être retirés plus tôt, sans préavis, en cas d’abus ou d’impératif technique ou juridique.";

/** Ce que deviennent les données à la fin de l'offre (même relecture). */
export const LAUNCH_OFFER_DATA_TEXT =
  "Vos données (favoris, alertes, rapports enregistrés) restent conservées tant que votre compte existe et dans les durées de la politique de confidentialité. Elles redeviennent accessibles avec l’offre Analyse.";

/**
 * Mention à un compte connecté : ses avantages Analyse sont ceux de l'offre de lancement (à condition
 * que son adresse email soit confirmée), temporaires, avec la durée dite par `LAUNCH_OFFER_DURATION_TEXT`.
 */
export const LAUNCH_OFFER_ACCOUNT_TEXT = `Offre de lancement : votre compte gratuit, une fois votre adresse email confirmée, bénéficie des avantages de l’offre Analyse. ${LAUNCH_OFFER_DURATION_TEXT}`;

/** Mention à un visiteur non connecté (appels à l'inscription). */
export const LAUNCH_OFFER_VISITOR_TEXT = `Offre de lancement : créez un compte gratuit, confirmez votre adresse email et accédez aux avantages de l’offre Analyse. ${LAUNCH_OFFER_DURATION_TEXT}`;

export type LaunchOfferAudience = "account" | "visitor";

/** La mention qui convient : compte connecté ou visiteur. */
export function launchOfferText(audience: LaunchOfferAudience): string {
  return audience === "account" ? LAUNCH_OFFER_ACCOUNT_TEXT : LAUNCH_OFFER_VISITOR_TEXT;
}

/** Réponse de `GET /api/launch-offer` : seul l'état, rien de personnel. */
export type LaunchOfferResponse = { active: boolean };

/**
 * Durée de cache serveur (processus) ET du CDN pour `GET /api/launch-offer` : l'une après l'autre,
 * elles retardent une coupure de 60 s au plus (le brief du propriétaire : 60 s maximum).
 */
export const LAUNCH_OFFER_CACHE_SECONDS = 30;

/** Lit la réponse de `/api/launch-offer` sans faire confiance à sa forme. */
export function parseLaunchOfferResponse(value: unknown): boolean | null {
  if (typeof value !== "object" || value === null) return null;
  const active = (value as { active?: unknown }).active;
  return typeof active === "boolean" ? active : null;
}
