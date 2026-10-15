import type { MarketEstimate } from "@/lib/market.server";
import { resolveMarketGap } from "@/lib/market-gap";

/** What a free account sees of the valuation: a range and the gap with the starting price. */
export type ValuePreview = {
  available: boolean;
  lowEur: number | null;
  highEur: number | null;
  /**
   * Starting price below (positive) or above (negative) the median estimate, in %. `null` when
   * there is no gap to show, and also for an implausible gap (see `discountNotSignificant`).
   */
  discountPct: number | null;
  /**
   * The gap is outside the range where a percentage means something (`src/lib/market-gap.ts`):
   * show « écart non significatif » and the price per m² instead of `discountPct`
   * (`describeMarketGap` builds the sentence).
   */
  discountNotSignificant: boolean;
  /** Starting price per m² of the estimate's reference surface, filled with the notice above. */
  startingPricePerM2: number | null;
  reliability: "forte" | "correcte" | "fragile" | null;
};

const roundThousand = (value: number) => Math.round(value / 1000) * 1000;

export function buildValuePreview(
  estimate: MarketEstimate | null,
  startingPrice: number | null,
): ValuePreview {
  const value = estimate?.actionable ? (estimate.estimatedValueEur ?? null) : null;
  if (!value || value <= 0) {
    return {
      available: false,
      lowEur: null,
      highEur: null,
      discountPct: null,
      discountNotSignificant: false,
      startingPricePerM2: null,
      reliability: null,
    };
  }
  const gap = resolveMarketGap({
    estimatedValueEur: value,
    startingPriceEur: startingPrice,
    surfaceM2: estimate?.subjectSurfaceM2,
  });
  const low = estimate?.estimatedValueLowEur ?? value * 0.85;
  const high = estimate?.estimatedValueHighEur ?? value * 1.15;
  return {
    available: true,
    lowEur: roundThousand(Math.min(low, value)),
    highEur: roundThousand(Math.max(high, value)),
    discountPct: gap.status === "gap" ? gap.discountPct : null,
    discountNotSignificant: gap.status === "not_significant",
    startingPricePerM2: gap.status === "not_significant" ? gap.startingPricePerM2 : null,
    reliability: estimate?.qualityLabel ?? null,
  };
}
