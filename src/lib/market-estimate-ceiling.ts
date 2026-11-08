import { passesPublicEstimateGate } from "@/lib/market-estimate-display";
import type { MarketContext, MarketEstimate } from "@/lib/market-server/types";

/**
 * The reference value of a sale as the bid ceiling reads it, and nothing more. A Découverte account
 * that unlocked a sale receives this instead of the detailed estimate (range, quartiles, extremes,
 * comparable transactions, address history, model diagnostics), which stay with Analyse.
 *
 * Every field below is read by `buildCeilingHypotheses` / the ceiling engine or displayed next to
 * the ceiling (value, source, date, reliability, number of sales behind it). The ceiling treats fewer
 * than 8 sales as fragile and reads the effective sample size for that; the page says how many sales
 * there are with `sampleSize`, the real (whole) count. `engineKind` and `publicGatePassed` decide how
 * the value is worded next to the starting price (`market-estimate-display.ts`).
 */
export type CeilingMarketEstimate = Pick<
  MarketEstimate,
  | "source"
  | "engineKind"
  | "sourceUpdatedAt"
  | "subjectSurfaceEstimated"
  | "estimatedValueEur"
  | "actionable"
  | "qualityLabel"
  | "sampleSize"
  | "effectiveSampleSize"
  | "medianPricePerM2"
  | "p75PricePerM2"
> & {
  /** The estimate passes the public gate (`passesPublicEstimateGate`): a point value may be shown. */
  publicGatePassed?: boolean;
};

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

/** A point value (« Valeur estimée à … ») only for an estimate that passes the public gate. */
export function showsPointEstimate(estimate: SaleMarketEstimate | null | undefined): boolean {
  if (estimate == null) return false;
  return isDetailedMarketEstimate(estimate)
    ? passesPublicEstimateGate(estimate)
    : estimate.publicGatePassed === true;
}

export function ceilingMarketEstimate(estimate: MarketEstimate): CeilingMarketEstimate {
  return {
    source: estimate.source,
    engineKind: estimate.engineKind ?? "comparable_ensemble",
    sourceUpdatedAt: estimate.sourceUpdatedAt ?? null,
    subjectSurfaceEstimated: estimate.subjectSurfaceEstimated === true,
    estimatedValueEur: estimate.estimatedValueEur ?? null,
    actionable: estimate.actionable === true,
    qualityLabel: estimate.qualityLabel,
    sampleSize: estimate.sampleSize,
    ...(estimate.effectiveSampleSize != null
      ? { effectiveSampleSize: estimate.effectiveSampleSize }
      : {}),
    medianPricePerM2: estimate.medianPricePerM2,
    p75PricePerM2: estimate.p75PricePerM2,
    publicGatePassed: passesPublicEstimateGate(estimate),
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
