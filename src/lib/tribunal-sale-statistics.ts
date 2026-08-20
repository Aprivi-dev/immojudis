import type {
  TribunalStatisticsDistribution,
  TribunalStatisticsItem,
  TribunalStatisticsMetric,
} from "@/lib/tribunal-statistics";

export type TribunalSaleCompactMetrics = {
  eligibleRounds: number | null;
  finalToInitialMedian: number | null;
  finalToInitialSample: number | null;
  adjudicatedRate: number | null;
  adjudicatedSample: number | null;
  overbidRate: number | null;
  overbidSample: number | null;
  coverage: number | null;
};

export function tribunalSaleCompactMetrics(
  item: TribunalStatisticsItem,
): TribunalSaleCompactMetrics {
  const initial = publishedDistribution(item.priceRatios.finalToInitial);
  const adjudicated = publishedMetric(item.flow.adjudicatedIfHeld);
  const overbid = publishedMetric(item.surenchere.filed);

  return {
    eligibleRounds: item.samples.eligibleRounds,
    finalToInitialMedian: initial?.adjusted.p50 ?? null,
    finalToInitialSample: initial?.sampleSize ?? null,
    adjudicatedRate: adjudicated?.adjustedValue ?? null,
    adjudicatedSample: adjudicated?.knownDenominator ?? null,
    overbidRate: overbid?.adjustedValue ?? null,
    overbidSample: overbid?.knownDenominator ?? null,
    coverage: item.reliability.coverage,
  };
}

export function formatRatioDelta(value: number | null): string {
  if (value == null) return "Non publié";
  const delta = (value - 1) * 100;
  const formatted = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(
    Math.abs(delta),
  );
  if (Math.abs(delta) < 0.5) return "≈ marché";
  return `${delta > 0 ? "+" : "−"}${formatted} %`;
}

export function formatProbability(value: number | null): string {
  if (value == null) return "Non publié";
  return new Intl.NumberFormat("fr-FR", {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value);
}

function publishedDistribution(value: TribunalStatisticsDistribution) {
  return value.method === "suppressed" ? null : value;
}

function publishedMetric(value: TribunalStatisticsMetric) {
  return value.method === "suppressed" ? null : value;
}
