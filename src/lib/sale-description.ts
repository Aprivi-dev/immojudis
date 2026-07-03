import type { AuctionSale } from "@/lib/types";

const AI_DESCRIPTION_PENDING =
  "Synthèse IA en cours de génération. Les informations extraites de l'annonce et des pièces seront affichées ici après réécriture automatique.";

function clean(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

export function getSaleAiDescription(sale: AuctionSale): string | null {
  return clean(sale.llm_display_description);
}

export function getSaleDisplayDescription(sale: AuctionSale): string {
  return getSaleAiDescription(sale) ?? AI_DESCRIPTION_PENDING;
}

export function hasSaleAiDescription(sale: AuctionSale): boolean {
  return getSaleAiDescription(sale) !== null;
}
