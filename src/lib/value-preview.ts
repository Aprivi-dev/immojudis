import type { MarketEstimate } from "@/lib/market.server";
import { resolveMarketGap } from "@/lib/market-gap";
import { marketGapWithheldReason } from "@/lib/market-gap-band";

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
  /**
   * Why the gap is not given although the range is: the property is occupied, or its occupation is
   * unknown, so the comparison with the sales of vacant properties does not hold. The same rule as
   * the public band (`marketGapWithheldReason`). `null` for a property known to be vacant.
   */
  gapWithheld: "occupied" | "occupancy_unknown" | null;
};

const roundThousand = (value: number) => Math.round(value / 1000) * 1000;

export function buildValuePreview(
  estimate: MarketEstimate | null,
  startingPrice: number | null,
  /** `occupancy_status` of the sale: the gap is only given for a property known to be vacant. */
  occupancyStatus: string | null | undefined,
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
      gapWithheld: null,
    };
  }
  const gapWithheld = marketGapWithheldReason(occupancyStatus);
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
    // Occupied or unknown occupation: the range stays, the gap (a percentage or « non significatif »)
    // does not, as on the public sale page.
    discountPct: !gapWithheld && gap.status === "gap" ? gap.discountPct : null,
    discountNotSignificant: !gapWithheld && gap.status === "not_significant",
    startingPricePerM2:
      !gapWithheld && gap.status === "not_significant" ? gap.startingPricePerM2 : null,
    reliability: estimate?.qualityLabel ?? null,
    gapWithheld,
  };
}
