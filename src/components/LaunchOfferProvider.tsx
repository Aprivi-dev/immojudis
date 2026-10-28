"use client";

import { useState, type ReactNode } from "react";
import { createLaunchOfferStore, LaunchOfferContext } from "@/hooks/use-launch-offer";

/**
 * Porte le magasin de l'état de l'offre de lancement. La requête (`GET /api/launch-offer`) ne part
 * que lorsqu'un composant qui en a besoin se monte.
 *
 * `initialActive` : l'état lu par le serveur au rendu de la page (`readLaunchOfferState`). Une page
 * qui l'a (accueil, /offres) enveloppe son contenu dans un fournisseur à elle : le HTML serveur
 * affiche l'état réel au lieu de « pas encore lu ». Le fournisseur de l'application, sans valeur,
 * garde le comportement d'avant.
 */
export function LaunchOfferProvider({
  children,
  initialActive,
}: {
  children: ReactNode;
  initialActive?: boolean;
}) {
  const [store] = useState(() => createLaunchOfferStore(undefined, undefined, initialActive));
  return <LaunchOfferContext.Provider value={store}>{children}</LaunchOfferContext.Provider>;
}
