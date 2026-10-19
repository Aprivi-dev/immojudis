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
 * Mention à un compte connecté : ses avantages Analyse sont ceux de l'offre de lancement, et ils
 * peuvent lui être retirés sans préavis au lancement officiel du site.
 */
export const LAUNCH_OFFER_ACCOUNT_TEXT =
  "Offre de lancement : votre compte gratuit bénéficie des avantages de l’offre Analyse. Ces avantages pourront vous être retirés, sans préavis, dès le lancement officiel du site.";

/** Mention à un visiteur non connecté (appels à l'inscription). */
export const LAUNCH_OFFER_VISITOR_TEXT =
  "Offre de lancement : créez un compte gratuit et accédez aux avantages de l’offre Analyse (avantages retirables sans préavis au lancement officiel).";

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
