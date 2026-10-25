/**
 * État de l'essai gratuit à l'inscription (interrupteur `app_private.launch_offer`) tel que le lit le
 * navigateur. Module minimal, sans texte : il est chargé sur toutes les pages (`client-billing`),
 * les textes de l'essai restent dans `src/lib/launch-offer.ts`.
 */

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
