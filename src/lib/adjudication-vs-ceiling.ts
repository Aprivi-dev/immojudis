import { formatPrice } from "@/lib/format";
import { isPastSaleDay } from "@/lib/sale-countdown";

/**
 * Après la vente (proposition n° 24) : sur la fiche d'une vente passée dont le prix est connu, une ligne neutre
 * qui place ce prix par rapport à l'enchère (ou l'offre) plafond estimée du compte. Aucun jugement : ni « bonne
 * affaire », ni « raté ». `null` hors vente passée, sans prix d'adjudication positif ou sans plafond calculé
 * (un compte qui n'a pas le droit au plafond n'en a pas : `ceilingEur` est alors absent).
 */
export function adjudicationVersusCeilingLine({
  adjudicationEur,
  ceilingEur,
  saleDate,
  ceilingTerm = "enchère plafond",
  byOffers = false,
  now,
}: {
  adjudicationEur: number | null | undefined;
  ceilingEur: number | null | undefined;
  saleDate: string | null | undefined;
  /** « enchère plafond » ou « offre plafond ». */
  ceilingTerm?: string;
  /** Vente par offres : le prix est un prix de vente, pas d'une adjudication. */
  byOffers?: boolean;
  now?: Date;
}): string | null {
  if (
    adjudicationEur == null ||
    !Number.isFinite(adjudicationEur) ||
    adjudicationEur <= 0 ||
    ceilingEur == null ||
    !Number.isFinite(ceilingEur) ||
    ceilingEur <= 0 ||
    !isPastSaleDay(saleDate, now)
  ) {
    return null;
  }
  const price = Math.round(adjudicationEur);
  const ceiling = Math.round(ceilingEur);
  const position =
    price > ceiling ? "au-dessus de" : price < ceiling ? "en dessous de" : "au niveau de";
  return `${byOffers ? "Vendue" : "Adjugée"} ${formatPrice(price)} : ${position} votre ${ceilingTerm} estimée (${formatPrice(ceiling)})`;
}
