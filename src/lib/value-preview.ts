import type { MarketEstimate } from "@/lib/market.server";

/** What a free account sees of the valuation: a range and the gap with the starting price. */
export type ValuePreview = {
  available: boolean;
  lowEur: number | null;
  highEur: number | null;
  /** Starting price below (positive) or above (negative) the median estimate, in %. */
  discountPct: number | null;
  reliability: "forte" | "correcte" | "fragile" | null;
};

const roundThousand = (value: number) => Math.round(value / 1000) * 1000;

export function buildValuePreview(
  estimate: MarketEstimate | null,
  startingPrice: number | null,
): ValuePreview {
  const value = estimate?.actionable ? (estimate.estimatedValueEur ?? null) : null;
  if (!value || value <= 0) {
    return { available: false, lowEur: null, highEur: null, discountPct: null, reliability: null };
  }
  const low = estimate?.estimatedValueLowEur ?? value * 0.85;
  const high = estimate?.estimatedValueHighEur ?? value * 1.15;
  return {
    available: true,
    lowEur: roundThousand(Math.min(low, value)),
    highEur: roundThousand(Math.max(high, value)),
    discountPct:
      startingPrice && startingPrice > 0
        ? Math.round(((value - startingPrice) / value) * 100)
        : null,
    reliability: estimate?.qualityLabel ?? null,
  };
}
