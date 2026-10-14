import type { MarketContext, MarketEstimate } from "@/lib/market-server/types";

/**
 * The reference value of a sale as the bid ceiling reads it, and nothing more. A Découverte account
 * that unlocked a sale receives this instead of the detailed estimate (range, quartiles, extremes,
 * comparable transactions, address history, model diagnostics), which stay with Analyse.
 *
 * Every field below is read by `buildCeilingHypotheses` / the ceiling engine or displayed next to
 * the ceiling (value, source, date, reliability, number of sales behind it). The ceiling treats fewer
 * than 8 sales as fragile, so one sample size is kept: the projection sends the effective one in
 * `sampleSize` and leaves `effectiveSampleSize` out.
 */
export type CeilingMarketEstimate = Pick<
  MarketEstimate,
  | "source"
  | "sourceUpdatedAt"
  | "subjectSurfaceEstimated"
  | "estimatedValueEur"
  | "actionable"
  | "qualityLabel"
  | "sampleSize"
  | "effectiveSampleSize"
  | "medianPricePerM2"
  | "p75PricePerM2"
>;

export type CeilingMarketContext = Omit<MarketContext, "estimate"> & {
  estimate: CeilingMarketEstimate | null;
};

/** The estimate sent to an account: the whole one (Analyse) or the ceiling projection (unlock). */
export type SaleMarketEstimate = MarketEstimate | CeilingMarketEstimate;
export type SaleMarketContext = Omit<MarketContext, "estimate"> & {
  estimate: SaleMarketEstimate | null;
};

export function isDetailedMarketEstimate(
  estimate: SaleMarketEstimate | null | undefined,
): estimate is MarketEstimate {
  return estimate != null && "recentTransactions" in estimate;
}

export function ceilingMarketEstimate(estimate: MarketEstimate): CeilingMarketEstimate {
  return {
    source: estimate.source,
    sourceUpdatedAt: estimate.sourceUpdatedAt ?? null,
    subjectSurfaceEstimated: estimate.subjectSurfaceEstimated === true,
    estimatedValueEur: estimate.estimatedValueEur ?? null,
    actionable: estimate.actionable === true,
    qualityLabel: estimate.qualityLabel,
    sampleSize: estimate.effectiveSampleSize ?? estimate.sampleSize,
    medianPricePerM2: estimate.medianPricePerM2,
    p75PricePerM2: estimate.p75PricePerM2,
  };
}

/** The response of `/api/market-estimate` on the unlock path. */
export function ceilingMarketContext(context: MarketContext): CeilingMarketContext {
  return {
    ok: context.ok,
    error: context.error,
    estimate: context.estimate ? ceilingMarketEstimate(context.estimate) : null,
    ...(context.status !== undefined ? { status: context.status } : {}),
    ...(context.code !== undefined ? { code: context.code } : {}),
    ...(context.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: context.retryAfterSeconds }
      : {}),
    ...(context.computedAt !== undefined ? { computedAt: context.computedAt } : {}),
  };
}
