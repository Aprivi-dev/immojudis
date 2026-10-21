/**
 * Consentement aux cookies de mesure d'audience de Google Analytics, côté navigateur (voir
 * « Cookies, stockage local et mesure d'audience » dans la politique de confidentialité).
 *
 * Contrairement à Vercel Analytics (sans cookie, opposition possible : `audience-opt-out.ts`),
 * Google Analytics dépose des cookies : il n'est chargé qu'après un accord explicite. Le choix,
 * accord comme refus, est mémorisé dans `localStorage` avec sa date et redemandé après
 * `ANALYTICS_CONSENT_MAX_AGE_MS` (6 mois, durée recommandée par la CNIL). Si le stockage est
 * inaccessible, le choix vaut jusqu'à la fermeture de l'onglet.
 */

export const ANALYTICS_CONSENT_STORAGE_KEY = "immojudis:analytics-consent";
const ANALYTICS_CONSENT_EVENT = "immojudis:analytics-consent-change";
export const ANALYTICS_CONSENT_MAX_AGE_MS = 182 * 24 * 60 * 60 * 1000;

export type AnalyticsConsentChoice = "granted" | "denied";

type StoredChoice = { choice: AnalyticsConsentChoice; at: string };

/** Valeur retenue quand le stockage est inaccessible : le choix vaut pour l'onglet en cours. */
let memoryChoice: AnalyticsConsentChoice | null = null;

function parseStoredChoice(raw: string | null, now: number): AnalyticsConsentChoice | null {
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as Partial<StoredChoice>;
    if (stored.choice !== "granted" && stored.choice !== "denied") return null;
    const at = Date.parse(stored.at ?? "");
    if (!Number.isFinite(at) || at > now || now - at > ANALYTICS_CONSENT_MAX_AGE_MS) return null;
    return stored.choice;
  } catch {
    return null;
  }
}

/** Choix en cours de validité, ou `null` si la personne n'a pas (encore, ou plus) choisi. */
export function readAnalyticsConsent(now = Date.now()): AnalyticsConsentChoice | null {
  if (typeof window === "undefined") return null;
  if (memoryChoice !== null) return memoryChoice;
  try {
    return parseStoredChoice(window.localStorage.getItem(ANALYTICS_CONSENT_STORAGE_KEY), now);
  } catch {
    return null;
  }
}

export function setAnalyticsConsent(choice: AnalyticsConsentChoice, now = new Date()): void {
  if (typeof window === "undefined") return;
  memoryChoice = choice;
  try {
    const stored: StoredChoice = { choice, at: now.toISOString() };
    window.localStorage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, JSON.stringify(stored));
    // Le stockage a pris le choix : la mémoire n'a plus à le doubler.
    memoryChoice = null;
  } catch {
    // Stockage inaccessible : `memoryChoice` garde le choix pour cet onglet.
  }
  window.dispatchEvent(new Event(ANALYTICS_CONSENT_EVENT));
}

/** Pour `useSyncExternalStore` : change dans cet onglet ou dans un autre. */
export function subscribeAnalyticsConsent(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === ANALYTICS_CONSENT_STORAGE_KEY) onChange();
  };
  window.addEventListener(ANALYTICS_CONSENT_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(ANALYTICS_CONSENT_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
