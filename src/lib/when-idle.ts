/**
 * Exécute `callback` quand le navigateur est inactif (`requestIdleCallback`), au plus tard après
 * `timeoutMs`. Safari n'a pas `requestIdleCallback` : on se rabat sur un `setTimeout`.
 * Retourne la fonction qui annule l'appel.
 */
export function whenIdle(callback: () => void, timeoutMs = 2_000): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(callback, { timeout: timeoutMs });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(callback, Math.min(timeoutMs, 500));
  return () => window.clearTimeout(handle);
}
