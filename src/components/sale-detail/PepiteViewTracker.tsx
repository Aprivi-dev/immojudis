"use client";

import { useEffect } from "react";
import { trackProductEvent } from "@/lib/product-events";
import type { PepitePayload } from "@/lib/sale-pepite-view";

/** Ventes dont le bloc a déjà été compté dans cette page, par niveau : un seul événement chacune. */
const counted = new Set<string>();

/**
 * Mesure `pepite_block_viewed` : le bloc « Pourquoi cette pépite » vient de s'afficher, avec son
 * niveau (`locked` : noms des critères seuls ; `detail` : détail ouvert). Une fois par vente et par
 * niveau dans la page ; l'événement ne porte ni l'identifiant de la vente ni celui de la personne
 * (liste fermée de `product-events.ts`). Ne rend rien : monté à côté du bloc, qui reste sans mesure.
 */
export function PepiteViewTracker({
  payload,
  saleId,
}: {
  payload: Pick<PepitePayload, "access"> | null;
  saleId: string;
}) {
  const access = payload?.access === "detail" ? "detail" : payload ? "locked" : null;
  useEffect(() => {
    if (!access) return;
    const key = `${saleId}:${access}`;
    if (counted.has(key)) return;
    counted.add(key);
    trackProductEvent("pepite_block_viewed", { access });
  }, [access, saleId]);
  return null;
}
