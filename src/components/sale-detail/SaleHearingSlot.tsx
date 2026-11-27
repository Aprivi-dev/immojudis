"use client";

import { createContext, useContext, type ReactNode } from "react";

const SaleHearingSlotContext = createContext<ReactNode>(null);

/**
 * Le bandeau des ventes de la même audience (`SaleHearingNav`), rendu par le serveur avec la page.
 * Un contexte plutôt qu'une propriété : la fiche publique et les trois vues connectées le posent au
 * même endroit, sans que chaque vue ait à le faire suivre, et son code ne part pas dans le navigateur.
 */
export function SaleHearingSlotProvider({
  nav,
  children,
}: {
  nav: ReactNode;
  children: ReactNode;
}) {
  return <SaleHearingSlotContext.Provider value={nav}>{children}</SaleHearingSlotContext.Provider>;
}

/** L'emplacement du bandeau dans une vue ; rien quand la vente n'a pas d'audience partagée. */
export function SaleHearingSlot({ className }: { className?: string }) {
  const nav = useContext(SaleHearingSlotContext);
  return nav ? <div className={className}>{nav}</div> : null;
}
