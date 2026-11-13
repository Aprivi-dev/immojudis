"use client";

import { useCallback, useSyncExternalStore } from "react";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

const serverSnapshot = () => false;

// Sans `matchMedia` (jsdom des tests), la requête vaut `false`, comme au rendu serveur.
function mediaQueryList(query: string): MediaQueryList | null {
  return typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
}

/**
 * La requête média `query` est-elle vérifiée, suivie en direct ? Rendu serveur et hydratation :
 * `false`, puis la vraie valeur dès le premier rendu du navigateur.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = mediaQueryList(query);
      media?.addEventListener("change", onChange);
      return () => media?.removeEventListener("change", onChange);
    },
    [query],
  );
  const snapshot = useCallback(() => mediaQueryList(query)?.matches ?? false, [query]);
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

/** Le visiteur a-t-il demandé de réduire les animations ? */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery(REDUCED_MOTION);
}
