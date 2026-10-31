import type { MarketEstimate } from "./types";

/**
 * Période couverte par tout l'échantillon de ventes retenu (dates ISO min et max), et non par les
 * seules ventes listées dans `recentTransactions`. `null` sans date exploitable.
 */
export function salesSamplePeriod(
  dates: ReadonlyArray<string | null | undefined>,
): MarketEstimate["samplePeriod"] {
  const valid = dates.filter(
    (date): date is string => typeof date === "string" && Number.isFinite(Date.parse(date)),
  );
  if (!valid.length) return null;
  const sorted = [...valid].sort();
  return { from: sorted[0], to: sorted[sorted.length - 1] };
}
