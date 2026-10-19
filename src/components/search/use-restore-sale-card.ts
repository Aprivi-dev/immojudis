import { useEffect, useRef } from "react";
import { SALE_CARD_ANCHOR_PREFIX } from "@/lib/navigation";
import { scrollToSaleCard } from "./scroll-to-sale-card";

/** Identifiant de la carte demandée par l'adresse (`#sale-card-<id>`), ou `null`. */
export function saleCardIdFromHash(hash: string): string | null {
  const anchor = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!anchor.startsWith(SALE_CARD_ANCHOR_PREFIX)) return null;
  try {
    return decodeURIComponent(anchor.slice(SALE_CARD_ANCHOR_PREFIX.length)) || null;
  } catch {
    return null;
  }
}

/**
 * « Retour aux ventes » depuis une fiche arrive sur `/sales?…#sale-card-<id>` : une fois la liste
 * affichée, elle défile jusqu'à la carte de la vente consultée. Une seule fois par arrivée sur la
 * page ; une carte absente de la page (autre page de résultats, filtre changé) ne fait rien.
 */
export function useRestoreSaleCard(listReady: boolean) {
  const restored = useRef(false);
  useEffect(() => {
    if (!listReady || restored.current) return;
    const saleId = saleCardIdFromHash(window.location.hash);
    if (!saleId) return;
    restored.current = true;
    scrollToSaleCard(saleId, { behavior: "instant" });
  }, [listReady]);
}
