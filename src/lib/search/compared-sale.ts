import { getSaleById, getSalePreviewById } from "@/lib/queries";
import type { AuctionSale } from "@/lib/types";

/**
 * La vente demandée par `/sales?comparer=<id>` (bouton « Comparer » d'une fiche), pour l'ajouter à
 * la comparaison. Un compte la lit avec ses droits (vue réduite de l'offre Découverte comprise) ; un
 * visiteur, ou un compte pour qui elle n'est pas lisible, en reçoit les faits publics de la carte.
 * La comparaison ne garde de toute façon que ces faits (`toComparedSale`).
 *
 * Chargé à la demande par `SearchPage`, seulement quand l'adresse porte ce paramètre.
 */
export async function fetchComparedSale(
  id: string,
  { signedIn, discovery }: { signedIn: boolean; discovery: boolean },
): Promise<AuctionSale | null> {
  if (signedIn) {
    const sale = await getSaleById(id, { discovery });
    if (sale) return sale;
  }
  return getSalePreviewById(id);
}
