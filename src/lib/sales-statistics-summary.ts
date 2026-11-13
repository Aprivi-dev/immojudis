import { extractDpe, type DpeClass } from "@/lib/dpe";
import { emptyDpeCounts } from "@/lib/dpe-counts";
import { pricePerM2 } from "@/lib/geo";
import { averageRounded, round } from "@/lib/rounding";
import { getSaleSurface } from "@/lib/surface";
import type { AuctionSale } from "@/lib/types";

/**
 * Les repères d'un échantillon de ventes affichés par le panneau de la recherche : la même règle
 * pour les statistiques du serveur (`sales-statistics.ts`) et le résumé que le catalogue calcule
 * sur la page affichée. Module sans code serveur, importable côté client.
 */
export type SalesSampleSummary = {
  medianPriceEur: number | null;
  medianPricePerM2: number | null;
  averageInvestmentScore: number | null;
  dpeKnownCount: number;
  dpeCounts: Record<DpeClass, number>;
};

export function summarizeSalesSample(sales: AuctionSale[]): SalesSampleSummary {
  const prices = sales.map((sale) => sale.starting_price_eur).filter(isPositiveNumber);
  const pricePerM2Values = sales
    .map((sale) => pricePerM2(sale.starting_price_eur, getSaleSurface(sale).value))
    .filter(isPositiveNumber);
  const scores = sales.map((sale) => sale.investment_score).filter(isFiniteNumber);
  const dpeCounts = emptyDpeCounts();
  let dpeKnownCount = 0;

  for (const sale of sales) {
    const dpe = extractDpe(sale).class;
    if (dpe) {
      dpeCounts[dpe] += 1;
      dpeKnownCount += 1;
    }
  }

  return {
    medianPriceEur: medianRounded(prices),
    medianPricePerM2: medianRounded(pricePerM2Values),
    averageInvestmentScore: averageRounded(scores),
    dpeKnownCount,
    dpeCounts,
  };
}

export function medianRounded(values: number[], digits = 0): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return round(value, digits);
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveNumber(value: number | null | undefined): value is number {
  return isFiniteNumber(value) && value > 0;
}
