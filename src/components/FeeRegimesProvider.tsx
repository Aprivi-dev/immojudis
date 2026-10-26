"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { FeeRegimeKey } from "@/lib/fee-regime-open";

/**
 * L'interrupteur par régime (`CEILING_FEE_REGIMES_OPEN`) tel que le serveur l'a lu, pour les
 * composants du navigateur loin de leur page serveur (cartes de résultats, accueil du compte). Un
 * composant hors de ce fournisseur garde le comportement par défaut : tous les régimes définis.
 */
export type FeeRegimesSettings = {
  /** Régimes de frais ouverts. */
  open: readonly FeeRegimeKey[];
  /** Note « le plafond n'existe que pour… », composée sur le serveur. */
  scopeNote: string;
};

const FeeRegimesContext = createContext<FeeRegimesSettings | null>(null);

export function FeeRegimesProvider({
  value,
  children,
}: {
  value: FeeRegimesSettings;
  children: ReactNode;
}) {
  return <FeeRegimesContext.Provider value={value}>{children}</FeeRegimesContext.Provider>;
}

/** `null` : aucun fournisseur, donc les valeurs par défaut. */
export function useFeeRegimes(): FeeRegimesSettings | null {
  return useContext(FeeRegimesContext);
}
