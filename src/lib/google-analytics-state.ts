import { readAnalyticsConsent, subscribeAnalyticsConsent } from "@/lib/analytics-consent";
import { isAudienceOptedOut, subscribeAudienceOptOut } from "@/lib/audience-opt-out";

/**
 * État de Google Analytics côté navigateur et pages où il ne se monte jamais. Ce module est léger
 * et séparé de `google-analytics.ts` (balise, nettoyage des adresses) : `DeferredGoogleAnalytics`
 * l'emploie pour décider de charger ou non le reste.
 */

/**
 * - `pending` : côté serveur ou avant l'hydratation, rien n'est décidé ;
 * - `unset` : aucun choix en cours de validité, le bandeau le demande ;
 * - `granted` / `denied` : choix du visiteur (l'opposition à la mesure d'audience vaut refus).
 */
export type GoogleAnalyticsState = "pending" | "unset" | "granted" | "denied";

export function getGoogleAnalyticsState(): GoogleAnalyticsState {
  if (typeof window === "undefined") return "pending";
  if (isAudienceOptedOut()) return "denied";
  return readAnalyticsConsent() ?? "unset";
}

export function getGoogleAnalyticsServerState(): GoogleAnalyticsState {
  return "pending";
}

export function subscribeGoogleAnalyticsState(onChange: () => void): () => void {
  const unsubscribeOptOut = subscribeAudienceOptOut(onChange);
  const unsubscribeConsent = subscribeAnalyticsConsent(onChange);
  return () => {
    unsubscribeOptOut();
    unsubscribeConsent();
  };
}

/**
 * Pages sur lesquelles ni Google Analytics ni son bandeau ne sont montés (ni leurs sous-chemins) :
 * espaces de la personne connectée, administration, dépôt d'informations par lien personnel et
 * exercice des droits. Le test `DeferredGoogleAnalytics.test.tsx` échoue si l'un d'eux y est monté.
 */
export const ANALYTICS_EXCLUDED_PATHS = [
  "/admin",
  "/compte",
  "/contribuer",
  "/login",
  "/mes-droits",
] as const;

export function isAnalyticsExcludedPath(pathname: string): boolean {
  return ANALYTICS_EXCLUDED_PATHS.some(
    (excluded) => pathname === excluded || pathname.startsWith(`${excluded}/`),
  );
}

/** Vrai si la balise est déjà chargée ou si des cookies Google Analytics sont présents. */
export function googleAnalyticsMayBeActive(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  if ("gtag" in window) return true;
  return /(?:^|;\s*)(?:_ga(?:_[^=]*)?|_gid|_gat(?:_[^=]*)?)=/.test(document.cookie);
}
