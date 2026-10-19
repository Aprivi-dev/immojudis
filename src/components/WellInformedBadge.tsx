import { isWellInformedSale } from "@/lib/listing-completeness-ranking";
import type { AuctionSale } from "@/lib/types";
import { WellInformedBadgeInfo } from "./WellInformedBadgeInfo";

/**
 * Pastille des cartes de résultats : l'annonce est dans le palier haut du classement par
 * complétude (voir `listing-completeness-ranking.ts`). Le libellé est visible, la réserve « ni
 * vérification ni garantie » s'ouvre au toucher et au clavier (voir `WellInformedBadgeInfo`).
 * Rien n'est affiché pour les autres annonces.
 */
export function WellInformedBadge({ sale }: { sale: Pick<AuctionSale, "completeness_tier"> }) {
  if (!isWellInformedSale(sale)) return null;
  return <WellInformedBadgeInfo />;
}
