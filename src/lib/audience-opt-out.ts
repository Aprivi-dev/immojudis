/**
 * Opposition à la mesure d'audience, côté navigateur (voir « Cookies, stockage local et mesure
 * d'audience » dans la politique de confidentialité).
 *
 * Le choix est mémorisé dans `localStorage` (propre à ce navigateur). Une fois l'opposition
 * activée, plus aucun événement de `product-events.ts` n'est envoyé et `Vercel Analytics` /
 * `Speed Insights` ne sont plus rendus (voir `AudienceMeasurement`). Si le stockage est
 * inaccessible (navigation privée stricte, stockage bloqué), le choix est tout de même respecté
 * jusqu'à la fermeture de l'onglet.
 *
 * S'opposer efface aussi l'accord aux cookies de Google Analytics (`analytics-consent.ts`) : après
 * le retrait de l'opposition, le bandeau redemande un choix au lieu de rétablir l'ancien accord.
 */

import { clearAnalyticsConsent } from "@/lib/analytics-consent";

export const AUDIENCE_OPT_OUT_STORAGE_KEY = "immojudis:audience-opt-out";
const AUDIENCE_OPT_OUT_EVENT = "immojudis:audience-opt-out-change";

/** Valeur retenue quand le stockage est inaccessible : le choix vaut pour l'onglet en cours. */
let memoryChoice: boolean | null = null;

export function isAudienceOptedOut(): boolean {
  if (typeof window === "undefined") return false;
  if (memoryChoice !== null) return memoryChoice;
  try {
    return window.localStorage.getItem(AUDIENCE_OPT_OUT_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAudienceOptOut(optedOut: boolean): void {
  if (typeof window === "undefined") return;
  memoryChoice = optedOut;
  try {
    if (optedOut) window.localStorage.setItem(AUDIENCE_OPT_OUT_STORAGE_KEY, "1");
    else window.localStorage.removeItem(AUDIENCE_OPT_OUT_STORAGE_KEY);
    // Le stockage a pris le choix : la mémoire n'a plus à le doubler.
    memoryChoice = null;
  } catch {
    // Stockage inaccessible : `memoryChoice` garde le choix pour cet onglet.
  }
  if (optedOut) clearAnalyticsConsent();
  window.dispatchEvent(new Event(AUDIENCE_OPT_OUT_EVENT));
}

/** Pour `useSyncExternalStore` : change dans cet onglet ou dans un autre. */
export function subscribeAudienceOptOut(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === AUDIENCE_OPT_OUT_STORAGE_KEY) onChange();
  };
  window.addEventListener(AUDIENCE_OPT_OUT_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(AUDIENCE_OPT_OUT_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
