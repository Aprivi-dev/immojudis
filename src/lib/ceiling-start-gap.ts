// Où se situe l'enchère plafond par rapport à la mise à prix, dit en toutes lettres (jamais par la
// seule couleur). Module pur, partagé par le verdict du plafond, la synthèse de la fiche et le
// panneau de décision.
import type { CeilingPlan } from "@/lib/bid-ceiling-engine";
import { formatPrice } from "@/lib/format";

/** Sous cette part de la mise à prix, l'écart au-dessus de la mise à prix est une marge étroite. */
export const NARROW_MARGIN_RATIO = 0.05;

export type CeilingStartGapKind = "above" | "narrow" | "below";

export type CeilingStartGap = {
  kind: CeilingStartGapKind;
  /** Plafond moins mise à prix, en euros (`startingPriceGap` du moteur). */
  gap: number;
  /** Phrase complète à afficher. */
  text: string;
};

/** Les mots du régime de la vente dont les phrases ont besoin (le tribunal par défaut). */
export type CeilingStartGapTerms = {
  /** « enchère plafond », « offre plafond ». */
  ceilingTerm: string;
  /** Le prix de départ, sans article : « mise à prix », « première offre possible ». */
  referencePriceTerm: string;
  /** Ce que le plafond permet : « enchérir » (enchères) ou « faire une offre allant » (offres). */
  bidVerb: string;
};

const TRIBUNAL_START_GAP_TERMS: CeilingStartGapTerms = {
  ceilingTerm: "enchère plafond",
  referencePriceTerm: "mise à prix",
  bidVerb: "enchérir",
};

/**
 * `null` quand la comparaison n'a pas de sens : plafond non chiffré ou inatteignable, mise à prix
 * absente ou nulle. `terms` : le vocabulaire du régime de la vente (« offre plafond », « première
 * offre possible », « faire une offre allant » pour une vente par offres).
 */
export function describeCeilingStartGap(
  plan: Pick<CeilingPlan, "available" | "reachable" | "maxBid" | "startingPriceGap">,
  startingPrice: number | null | undefined,
  terms: CeilingStartGapTerms = TRIBUNAL_START_GAP_TERMS,
): CeilingStartGap | null {
  const gap = plan.startingPriceGap;
  if (!plan.available || !plan.reachable || gap == null) return null;
  if (startingPrice == null || !Number.isFinite(startingPrice) || startingPrice <= 0) return null;

  const ceiling = formatPrice(plan.maxBid);
  const start = `la ${terms.referencePriceTerm}`;
  if (gap < 0) {
    return {
      kind: "below",
      gap,
      text: `Avec ces hypothèses, votre ${terms.ceilingTerm} (${ceiling}) est ${formatPrice(-gap)} (${formatPercent(-gap / startingPrice)}) sous ${start} : le bien ne tient pas à son prix de départ.`,
    };
  }
  if (gap < startingPrice * NARROW_MARGIN_RATIO) {
    const above =
      gap === 0 ? `soit exactement ${start}` : `soit ${formatPrice(gap)} au-dessus de ${start}`;
    return {
      kind: "narrow",
      gap,
      text: `Peu d’écart avec ${start} : selon vos hypothèses, vous pouvez ${terms.bidVerb} jusqu’à ${ceiling}, ${above}.`,
    };
  }
  return {
    kind: "above",
    gap,
    text: `Selon vos hypothèses, vous pouvez ${terms.bidVerb} jusqu’à ${ceiling}, soit ${formatPrice(gap)} au-dessus de ${start}.`,
  };
}

/**
 * « 12 % » à partir de 1 %, une décimale entre 0,1 % et 1 %, « moins de 0,1 % » en dessous : on
 * n'écrit jamais « 0 % » ni « −0 % » pour un écart qui existe.
 */
function formatPercent(ratio: number): string {
  const pct = ratio * 100;
  if (pct < 0.1) return "moins de 0,1 %";
  const value = pct >= 1 ? Math.round(pct) : Math.round(pct * 10) / 10;
  return `${value.toLocaleString("fr-FR")} %`;
}
