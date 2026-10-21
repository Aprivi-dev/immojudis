import { readAnalyticsConsent, subscribeAnalyticsConsent } from "@/lib/analytics-consent";
import { isAudienceOptedOut, subscribeAudienceOptOut } from "@/lib/audience-opt-out";

/**
 * Google Analytics 4 (balise `gtag.js`), chargé seulement après l'accord du visiteur (voir
 * `analytics-consent.ts` et `GoogleAnalytics`).
 *
 * Réglages volontaires :
 * - aucune page vue automatique (`send_page_view: false`) : `GoogleAnalytics` envoie chaque page
 *   vue avec une adresse nettoyée par `sanitizeAnalyticsUrl`, qui ne transmet ni jeton de partage,
 *   ni code de connexion, ni paramètre de recherche ; seuls les paramètres de campagne restent ;
 * - ni signaux Google ni personnalisation publicitaire ; stockage publicitaire refusé (Consent
 *   Mode), seul le stockage de mesure est accordé, puisque la personne l'a accepté ;
 * - cookies limités à 13 mois, sans prolongation à chaque visite (`cookie_expires`,
 *   `cookie_update: false`), comme le demande la CNIL ; Google les garde sinon deux ans ;
 * - l'opposition à la mesure d'audience (`audience-opt-out.ts`) l'emporte sur l'accord.
 *
 * À régler dans Google Analytics (Administration > Flux de données > Mesure améliorée) : désactiver
 * « Changements de page basés sur l'historique de navigation » (sinon chaque navigation compte
 * deux pages vues, la seconde avec l'adresse complète) et « Téléchargements de fichiers » (les
 * liens des pièces peuvent porter un jeton d'accès).
 */

export const GA_MEASUREMENT_ID = "G-FVY2EYX5MP";
export const GA_SCRIPT_URL = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
/** Durée de vie des cookies `_ga` : 13 mois (en secondes), plafond fixé par la CNIL. */
const GA_COOKIE_MAX_AGE_SECONDS = 13 * 30 * 24 * 60 * 60;

/** Paramètres d'adresse conservés : ceux qui attribuent la visite à une campagne. */
const CAMPAIGN_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "gbraid",
  "wbraid",
];

/** Chemins dont un segment est un jeton d'accès (lien de partage) : il n'est jamais transmis. */
const TOKEN_PATHS = [/^(\/reports\/shared\/)[^/]+/, /^(\/comparaisons\/)[^/]+/];

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
 * Adresse transmise à Google Analytics : sans fragment, sans jeton de partage et sans autre
 * paramètre que ceux de campagne. Une adresse d'un autre site est réduite à son origine.
 */
export function sanitizeAnalyticsUrl(href: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.origin !== origin) return `${url.origin}/`;

  let path = url.pathname;
  for (const pattern of TOKEN_PATHS) path = path.replace(pattern, "$1[jeton]");
  const kept = new URLSearchParams();
  for (const name of CAMPAIGN_PARAMS) {
    const value = url.searchParams.get(name);
    if (value !== null) kept.set(name, value);
  }
  const query = kept.toString();
  return `${url.origin}${path}${query ? `?${query}` : ""}`;
}

type Gtag = (...args: unknown[]) => void;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: Gtag;
  }
}

const DISABLE_FLAG = `ga-disable-${GA_MEASUREMENT_ID}`;
let configured = false;

function setDisabled(disabled: boolean): void {
  (window as unknown as Record<string, unknown>)[DISABLE_FLAG] = disabled;
}

/** Prépare `gtag` (une seule fois par chargement de page) et lève une suspension éventuelle. */
export function enableGoogleAnalytics(): void {
  setDisabled(false);
  if (configured) return;
  configured = true;
  window.dataLayer = window.dataLayer ?? [];
  // gtag.js attend l'objet `arguments` lui-même, pas un tableau.
  window.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  };
  window.gtag("consent", "default", {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: "granted",
  });
  window.gtag("js", new Date());
  window.gtag("config", GA_MEASUREMENT_ID, {
    send_page_view: false,
    cookie_expires: GA_COOKIE_MAX_AGE_SECONDS,
    cookie_update: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
}

export function trackGooglePageView(location: string, referrer: string | null): void {
  if (!configured || !window.gtag) return;
  const page = {
    page_location: location,
    page_referrer: referrer ?? "",
    page_title: document.title,
  };
  // `set` vaut aussi pour les événements suivants (défilement, clics) : aucun ne reprend
  // l'adresse complète du navigateur.
  window.gtag("set", page);
  window.gtag("event", "page_view", page);
}

/**
 * Retrait ou absence d'accord : plus aucun envoi si la balise est déjà chargée, et suppression des
 * cookies Google Analytics (`_ga`, `_ga_<flux>`, anciens `_gid` / `_gat`) sur ce domaine et ses
 * domaines parents, où `gtag.js` les dépose.
 */
export function revokeGoogleAnalytics(): void {
  if (typeof document === "undefined") return;
  if (configured) setDisabled(true);
  const names = document.cookie
    .split(";")
    .map((pair) => pair.split("=")[0]!.trim())
    .filter((name) => /^_ga(?:_|$)|^_gid$|^_gat(?:_|$)/.test(name));
  if (names.length === 0) return;
  const labels = window.location.hostname.split(".");
  const domains = [""];
  for (let index = 0; index < labels.length - 1; index += 1) {
    domains.push(`; domain=.${labels.slice(index).join(".")}`);
  }
  for (const name of names) {
    for (const domain of domains) {
      document.cookie = `${name}=; Max-Age=0; path=/${domain}`;
    }
  }
}
