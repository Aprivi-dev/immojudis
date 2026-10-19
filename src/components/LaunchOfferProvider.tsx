"use client";

import { useState, type ReactNode } from "react";
import { createLaunchOfferStore, LaunchOfferContext } from "@/hooks/use-launch-offer";

/**
 * Porte le magasin de l'état de l'offre de lancement pour toute l'application. La requête
 * (`GET /api/launch-offer`) ne part que lorsqu'un composant qui en a besoin se monte.
 */
export function LaunchOfferProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => createLaunchOfferStore());
  return <LaunchOfferContext.Provider value={store}>{children}</LaunchOfferContext.Provider>;
}
