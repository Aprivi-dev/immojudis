/**
 * Consentement aux cookies de mesure d'audience de Google Analytics, côté navigateur (voir
 * « Cookies, stockage local et mesure d'audience » dans la politique de confidentialité).
 *
 * Contrairement à Vercel Analytics (sans cookie, opposition possible : `audience-opt-out.ts`),
 * Google Analytics dépose des cookies : il n'est chargé qu'après un accord explicite. Le choix,
 * accord comme refus, est mémorisé dans `localStorage` avec sa date et redemandé après
 * `ANALYTICS_CONSENT_MAX_AGE_MS` (6 mois, durée recommandée par la CNIL) ou quand le texte
 * sur lequel il a été donné change (`ANALYTICS_CONSENT_TEXT_VERSION`). Si le stockage est
 * inaccessible, le choix vaut jusqu'à la fermeture de l'onglet.
 */

export const ANALYTICS_CONSENT_STORAGE_KEY = "immojudis:analytics-consent";
const ANALYTICS_CONSENT_EVENT = "immojudis:analytics-consent-change";
export const ANALYTICS_CONSENT_MAX_AGE_MS = 182 * 24 * 60 * 60 * 1000;
/**
 * Version du texte sur lequel le choix est donné (bandeau et section « Cookies » de la politique
 * de confidentialité). À incrémenter quand ce texte change sur le fond (finalité, destinataires,
 * durées) : les choix enregistrés avec une autre version ne comptent plus et le bandeau redemande.
 * Un choix enregistré avant l'introduction de la version vaut pour la version 1.
 */
export const ANALYTICS_CONSENT_TEXT_VERSION = 1;

export type AnalyticsConsentChoice = "granted" | "denied";

type StoredChoice = { choice: AnalyticsConsentChoice; at: string; version?: number };

/** Valeur retenue quand le stockage est inaccessible : le choix vaut pour l'onglet en cours. */
let memoryChoice: AnalyticsConsentChoice | null = null;

function parseStoredChoice(raw: string | null, now: number): AnalyticsConsentChoice | null {
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as Partial<StoredChoice>;
    if (stored.choice !== "granted" && stored.choice !== "denied") return null;
    if ((stored.version ?? 1) !== ANALYTICS_CONSENT_TEXT_VERSION) return null;
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
    const stored: StoredChoice = {
      choice,
      at: now.toISOString(),
      version: ANALYTICS_CONSENT_TEXT_VERSION,
    };
    window.localStorage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, JSON.stringify(stored));
    // Le stockage a pris le choix : la mémoire n'a plus à le doubler.
    memoryChoice = null;
  } catch {
    // Stockage inaccessible : `memoryChoice` garde le choix pour cet onglet.
  }
  window.dispatchEvent(new Event(ANALYTICS_CONSENT_EVENT));
}

/**
 * Efface le choix (accord ou refus) : le bandeau redemandera. Appelé quand la personne s'oppose à
 * la mesure d'audience, pour que le retrait de l'opposition ne rétablisse pas un ancien accord.
 */
export function clearAnalyticsConsent(): void {
  if (typeof window === "undefined") return;
  memoryChoice = null;
  try {
    window.localStorage.removeItem(ANALYTICS_CONSENT_STORAGE_KEY);
  } catch {
    // Stockage inaccessible : il n'y a rien d'autre à effacer que la mémoire de l'onglet.
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
