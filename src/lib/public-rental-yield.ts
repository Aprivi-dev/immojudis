import { feeRegimeKeyForSale } from "@/lib/fee-regime-key";
import { formatPercent, formatPrice } from "@/lib/format/numbers";
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

const percent = (value: number) => formatPercent(value, 1, 1);

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
 * Au-delà de ce rendement brut (le pourcentage le plus haut affiché), le rendement à la mise à prix
 * n'est plus significatif : la mise à prix d'une vente aux enchères est souvent très inférieure au
 * prix final, et la fiche affichait par exemple « entre 41,5 % et 80,3 % ». 15 % est une proposition
 * (P6, état des lieux du 08/11/2026), au-dessus des rendements bruts locatifs usuels en France ;
 * valeur à confirmer par le statisticien. Au seuil exactement, le rendement reste affiché.
 */
export const PUBLIC_YIELD_SIGNIFICANCE_MAX_PCT = 15;

/** Libellé du loyer affiché à la place d'un rendement non significatif. */
export const PUBLIC_MONTHLY_RENT_LABEL = "Loyer mensuel estimé (charges comprises)";

/** Mention qui accompagne le loyer affiché à la place d'un rendement non significatif. */
export const PUBLIC_YIELD_NOT_SIGNIFICANT_NOTE =
  "Rendement non significatif à la mise à prix : le prix final est souvent bien plus élevé.";

/**
 * Ce que la section « Marché local » affiche : le rendement brut à la mise à prix (`yield`) ou, quand
 * il dépasse `PUBLIC_YIELD_SIGNIFICANCE_MAX_PCT`, le loyer mensuel estimé du bien (`rent`).
 */
export type PublicRentalYield = { kind: "yield"; text: string } | { kind: "rent"; text: string };

/** Le pourcentage le plus haut que `publicYieldText` affiche ; `null` : il n'affiche rien. */
function highestDisplayedPct(
  range: GrossYieldRange,
  reliability: RentReference["reliability"],
): number | null {
  const bounds = range.lowPct != null && range.highPct != null ? [range.lowPct, range.highPct] : [];
  if (reliability === "reliable") return Math.max(range.centralPct, ...bounds);
  return bounds.length ? Math.max(...bounds) : null;
}

/** Loyer mensuel arrondi à la dizaine d'euros : l'estimation n'est pas plus précise. */
const monthlyRent = (surface: number, perM2: number) =>
  formatPrice(Math.round((surface * perM2) / 10) * 10);

/**
 * Le loyer mensuel estimé du bien (surface × loyer d'annonce au m²), avec la même règle que le
 * rendement : une référence fiable donne la valeur centrale et sa fourchette, une référence
 * indicative QUE la fourchette, et rien sans borne de loyer.
 */
function publicMonthlyRentText(surface: number, reference: RentReference): string | null {
  const { lowPerM2, highPerM2, rentPerM2 } = reference;
  const bounds =
    lowPerM2 != null && highPerM2 != null && lowPerM2 > 0 && highPerM2 > 0
      ? [Math.min(lowPerM2, highPerM2), Math.max(lowPerM2, highPerM2)]
      : null;
  if (reference.reliability === "reliable") {
    return bounds
      ? `${monthlyRent(surface, rentPerM2)} (de ${monthlyRent(surface, bounds[0])} à ${monthlyRent(surface, bounds[1])} selon la fourchette de loyer)`
      : monthlyRent(surface, rentPerM2);
  }
  return bounds
    ? `entre ${monthlyRent(surface, bounds[0])} et ${monthlyRent(surface, bounds[1])}`
    : null;
}

/**
 * Ce qu'affiche un rendement déjà calculé : son texte jusqu'au seuil inclus, au-delà le loyer
 * mensuel estimé du bien ; `null` quand le rendement ne s'affiche pas (référence indicative sans
 * bornes) ou que le loyer ne se calcule pas.
 */
export function publicRentalYieldFromRange(
  range: GrossYieldRange,
  reference: RentReference,
  surface: number,
): PublicRentalYield | null {
  const text = publicYieldText(range, reference.reliability);
  if (!text) return null;
  const highest = highestDisplayedPct(range, reference.reliability);
  if (highest == null || highest <= PUBLIC_YIELD_SIGNIFICANCE_MAX_PCT)
    return { kind: "yield", text };
  const rent = surface > 0 ? publicMonthlyRentText(surface, reference) : null;
  return rent ? { kind: "rent", text: rent } : null;
}

/**
 * Le rendement brut à la mise à prix, ou `null` : pas de loyer de la carte de l'ANIL, pas de mise à
 * prix, régime de frais inconnu (vente notariale aux conditions illisibles, vente domaniale) ou
 * surface absente. Au-delà de `PUBLIC_YIELD_SIGNIFICANCE_MAX_PCT`, le loyer mensuel estimé à la place.
 */
export function publicRentalYield(
  sale: AuctionSale,
  reference: RentReference | null | undefined,
): PublicRentalYield | null {
  const anil = isAnilRentReference(reference) ? reference : null;
  const price = sale.starting_price_eur;
  if (!anil || price == null || price <= 0 || feeRegimeKeyForSale(sale) == null) return null;
  const surface = sale.app_surface_m2 ?? null;
  const range = estimateSaleGrossYieldRange(sale, surface, anil);
  return range && surface ? publicRentalYieldFromRange(range, anil, surface) : null;
}
