import { formatNumber, formatPrice } from "@/lib/format";

/**
 * Verdict d'une enchère plafond face à la mise à prix (décision du propriétaire du 26/10/2026) :
 * « On enchérit » quand le plafond dépasse la mise à prix d'au moins 10 %, « Serré » entre 0 et
 * 10 %, « On passe son tour » quand la mise à prix dépasse déjà le plafond.
 */
export const TIGHT_MARGIN_PCT = 10;

export type BidVerdict = "go" | "tight" | "pass";

export const BID_VERDICT_LABEL: Record<BidVerdict, string> = {
  go: "On enchérit",
  tight: "Serré",
  pass: "On passe son tour",
};

export function bidVerdict(ceiling: number, startingPrice: number): BidVerdict {
  if (ceiling < startingPrice) return "pass";
  // En pourcentages entiers : 95 000 × 1,1 vaut 104 500,000…01 en virgule flottante.
  return ceiling * 100 >= startingPrice * (100 + TIGHT_MARGIN_PCT) ? "go" : "tight";
}

/** Une phrase qui chiffre l'écart entre le plafond et la mise à prix. */
export function bidVerdictSentence(ceiling: number, startingPrice: number): string {
  const gap = Math.abs(ceiling - startingPrice);
  switch (bidVerdict(ceiling, startingPrice)) {
    case "go":
      return `${formatPrice(gap)} de marge au-dessus de la mise à prix.`;
    case "tight":
      return `Seulement ${formatPrice(gap)} au-dessus de la mise à prix : peu de marge.`;
    case "pass":
      return `La mise à prix dépasse déjà votre plafond de ${formatPrice(gap)}.`;
  }
}

/** « 10 % », pour les textes qui énoncent la règle. */
export const TIGHT_MARGIN_LABEL = `${formatNumber(TIGHT_MARGIN_PCT)} %`;
