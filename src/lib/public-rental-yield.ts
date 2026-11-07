import { feeRegimeKeyForSale } from "@/lib/fee-regime-key";
import { estimateSaleGrossYieldRange, type GrossYieldRange } from "@/lib/geo";
import type { RentReference } from "@/lib/rent-reference";
import { isAnilRentReference } from "@/lib/rent-source-notice";
import type { AuctionSale } from "@/lib/types";

/**
 * Rendement brut de la fiche publique, calculé par le serveur au rendu de la page : la section
 * « Marché local » ne reçoit que le texte, sans embarquer dans le navigateur le calcul des frais
 * d'acquisition (budget de JavaScript client). Mêmes règles, mêmes mots que le bloc « Marché
 * locatif » de la fiche des comptes (`RentalMarketBlock`, `yieldText`) ; un test les compare.
 */
export const PUBLIC_YIELD_LABEL = "Rendement brut à la mise à prix (charges comprises)";

const percentFormat = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const percent = (value: number) => `${percentFormat.format(value)} %`;

/**
 * Une référence fiable donne la valeur centrale et sa fourchette ; une référence indicative ne donne
 * QUE la fourchette, jamais un chiffre ponctuel, et rien sans borne de loyer.
 */
export function publicYieldText(
  range: GrossYieldRange,
  reliability: RentReference["reliability"],
): string | null {
  const hasBounds = range.lowPct != null && range.highPct != null;
  const bounds = hasBounds
    ? [Math.min(range.lowPct!, range.highPct!), Math.max(range.lowPct!, range.highPct!)]
    : null;
  if (reliability === "reliable") {
    return bounds
      ? `${percent(range.centralPct)} (de ${percent(bounds[0])} à ${percent(bounds[1])} selon la fourchette de loyer)`
      : percent(range.centralPct);
  }
  return bounds ? `entre ${percent(bounds[0])} et ${percent(bounds[1])}` : null;
}

/**
 * Le texte du rendement brut à la mise à prix, ou `null` : pas de loyer de la carte de l'ANIL, pas de
 * mise à prix, régime de frais inconnu (vente notariale aux conditions illisibles, vente domaniale)
 * ou surface absente.
 */
export function publicRentalYield(
  sale: AuctionSale,
  reference: RentReference | null | undefined,
): string | null {
  const anil = isAnilRentReference(reference) ? reference : null;
  const price = sale.starting_price_eur;
  if (!anil || price == null || price <= 0 || feeRegimeKeyForSale(sale) == null) return null;
  const range = estimateSaleGrossYieldRange(sale, sale.app_surface_m2 ?? null, anil);
  return range ? publicYieldText(range, anil.reliability) : null;
}
