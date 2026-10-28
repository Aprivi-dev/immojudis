import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import { fetchLaunchOffer } from "@/lib/client-billing";

/**
 * État de l'offre de lancement vu par le navigateur : `GET /api/launch-offer`, lu une fois puis relu
 * au plus une fois par minute quand un nouveau composant en a besoin. Aucun composant ne lit de
 * variable d'environnement : la base est l'unique source (voir `src/lib/launch-offer.ts`).
 *
 * `pending` : la lecture n'est pas revenue. Une page dont le bouton principal change avec l'offre
 * (Offres, aperçus payants) affiche alors un emplacement neutre plutôt que la version « offre
 * fermée », qui clignoterait avant d'être remplacée. Sans fournisseur (composant testé seul), l'offre
 * est considérée comme absente et aucune requête n'est faite.
 *
 * Une page rendue côté serveur (accueil, /offres) lit l'état dans la base et le donne en valeur
 * initiale au fournisseur (`initialActive`) : le HTML serveur et l'hydratation partent alors de
 * l'état réel, non de « pas encore lu ». La lecture du navigateur le corrige ensuite si la page est
 * plus ancienne que l'état.
 */
export type LaunchOfferState = {
  /** Offre active. Faux tant que l'état n'est pas connu, et en cas d'erreur. */
  active: boolean;
  /** Vrai tant que la première lecture n'est pas terminée. */
  pending: boolean;
};

const NO_OFFER: LaunchOfferState = Object.freeze({ active: false, pending: false });
const PENDING: LaunchOfferState = Object.freeze({ active: false, pending: true });

/** Une lecture est considérée fraîche une minute. */
const FRESH_MS = 60_000;

export type LaunchOfferStore = {
  getSnapshot: () => LaunchOfferState;
  /** État du rendu serveur et de l'hydratation : la valeur initiale, ou « pas encore lu ». */
  getServerSnapshot: () => LaunchOfferState;
  subscribe: (listener: () => void) => () => void;
  /** Lance la lecture si elle n'a jamais eu lieu ou date de plus d'une minute. */
  ensure: () => void;
};

export function createLaunchOfferStore(
  read: () => Promise<boolean | null> = fetchLaunchOffer,
  now: () => number = Date.now,
  /** État lu par le serveur au rendu de la page ; absent : pas encore lu. */
  initialActive?: boolean,
): LaunchOfferStore {
  const initial: LaunchOfferState =
    initialActive === undefined
      ? PENDING
      : Object.freeze({ active: initialActive, pending: false });
  let state: LaunchOfferState = initial;
  let loadedAt: number | null = null;
  let inflight = false;
  const listeners = new Set<() => void>();

  function publish(next: LaunchOfferState) {
    if (next.active === state.active && next.pending === state.pending) return;
    state = next;
    for (const listener of [...listeners]) listener();
  }

  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure() {
      if (inflight) return;
      if (loadedAt !== null && now() - loadedAt < FRESH_MS) return;
      inflight = true;
      read()
        .then((active) => {
          // Réponse illisible : l'état lu par le serveur reste, faute de mieux.
          if (active === null && initialActive !== undefined) return;
          publish({ active: active === true, pending: false });
        })
        // Erreur réseau ou serveur : pas de surclassement affiché sur une supposition. Un état déjà
        // lu par le serveur n'en est pas une : il reste jusqu'à la prochaine lecture réussie.
        .catch(() => {
          if (initialActive === undefined) publish(NO_OFFER);
        })
        .finally(() => {
          inflight = false;
          loadedAt = now();
        });
    },
  };
}

export const LaunchOfferContext = createContext<LaunchOfferStore | null>(null);

const subscribeNever = () => () => {};
const noOffer = () => NO_OFFER;

export function useLaunchOffer(): LaunchOfferState {
  const store = useContext(LaunchOfferContext);
  const state = useSyncExternalStore(
    store?.subscribe ?? subscribeNever,
    store?.getSnapshot ?? noOffer,
    // Rendu serveur et hydratation : l'état lu par le serveur, ou « pas encore connu ».
    store ? store.getServerSnapshot : noOffer,
  );
  useEffect(() => {
    store?.ensure();
  }, [store]);
  return state;
}
