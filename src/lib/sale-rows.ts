import type { AuctionSale } from "./types";

/**
 * Lignes des vues du catalogue (`v_auction_sales_app`…) vues comme `AuctionSale`.
 *
 * Les vues exposent des colonnes nullable et des `Json` là où `AuctionSale` est le contrat
 * applicatif déjà validé côté base (visibilité, nettoyage) : le client typé ne peut donc pas
 * en déduire ce type. La conversion est centralisée ici plutôt que répétée à chaque requête.
 */
export function saleRows(data: unknown): AuctionSale[] {
  return (data ?? []) as AuctionSale[];
}

/** Une ligne de vue du catalogue vue comme `AuctionSale` (voir `saleRows`). */
export function saleRow(data: unknown): AuctionSale {
  return data as AuctionSale;
}
