import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * `false` dans le HTML du serveur et pendant l'hydratation, `true` ensuite dans le navigateur.
 * Sert aux messages qui ne décrivent que l'état du navigateur (vérification d'un compte, par
 * exemple) : le serveur ne sait rien du visiteur, ils ne doivent pas figurer dans le HTML que les
 * moteurs de recherche lisent.
 */
export function useHasHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
