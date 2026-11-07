import { toast } from "@/lib/toast";
import { fetchComparedSale } from "@/lib/search/compared-sale";
import {
  MAX_COMPARED_SALES,
  compareSaleIdFromParam,
  type ComparedSale,
} from "@/lib/search/sale-comparison";
import type { AuctionSale } from "@/lib/types";

/**
 * Suite de `useCompareFromAddress` (`/sales?comparer=<id>`), chargée à la demande : seule une adresse
 * qui porte ce paramètre paie la lecture de la vente et les messages, pas le catalogue ordinaire.
 * Ajoute la vente à la comparaison, ou dit pourquoi elle n'a pas pu l'être. `isCancelled` arrête tout
 * si le catalogue a changé de compte entre-temps.
 */
export async function addSaleFromAddress(
  rawId: string,
  {
    signedIn,
    discovery,
    items,
    toggle,
    isCancelled,
  }: {
    signedIn: boolean;
    discovery: boolean;
    items: () => ComparedSale[];
    toggle: (sale: AuctionSale) => void;
    isCancelled: () => boolean;
  },
): Promise<void> {
  const failed = () => {
    if (!isCancelled()) toast.message("Cette vente n’a pas pu être ajoutée à la comparaison.");
  };
  const id = compareSaleIdFromParam(rawId);
  if (!id) return;
  let sale: AuctionSale | null;
  try {
    sale = await fetchComparedSale(id, { signedIn, discovery });
  } catch {
    return failed();
  }
  if (isCancelled()) return;
  if (!sale) return failed();
  if (items().some((item) => item.id === sale.id)) return;
  if (items().length >= MAX_COMPARED_SALES) return failed();
  toggle(sale);
  toast.message(
    `Vente ajoutée à la comparaison. Choisissez jusqu’à ${MAX_COMPARED_SALES - 1} autres biens dans la liste.`,
  );
}
