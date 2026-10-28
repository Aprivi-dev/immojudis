import type { AuctionSale } from "@/lib/types";

/**
 * Points que la carte dessine quand la recherche en compte plus que `limit` : les pépites d'abord
 * (dans l'ordre de la recherche), puis les autres ventes dans leur ordre. Sans ce tri, couper la
 * liste au plafond écarterait des pépites au niveau France (environ 1 700 ventes pour 500 points).
 * Sous le plafond, rien ne change : même liste, même ordre.
 */
export function capMapPoints<T extends Pick<AuctionSale, "id">>(
  sales: readonly T[],
  limit: number,
  pepiteSaleIds: ReadonlySet<string> | undefined,
): T[] {
  if (sales.length <= limit) return [...sales];
  if (!pepiteSaleIds || pepiteSaleIds.size === 0) return sales.slice(0, limit);
  const pepites: T[] = [];
  const others: T[] = [];
  for (const sale of sales) {
    (pepiteSaleIds.has(sale.id.toLowerCase()) ? pepites : others).push(sale);
  }
  return [...pepites, ...others].slice(0, limit);
}
