import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { DPE_CLASSES, extractDpe, type DpeClass } from "@/lib/dpe";
import { estimateGrossYieldPct, geocodeAddress, pricePerM2 } from "@/lib/geo";
import { featureIncluded } from "@/lib/plans";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import { getSales } from "@/lib/queries";
import {
  applyClientSearchFilters,
  dataFiltersFromSearch,
  dataSortFromSearch,
  sortClientSearchResults,
} from "@/lib/search/search-filters";
import { salesSearchToUrlRecord, type SalesSearchParams } from "@/lib/search/search-url-state";
import { getSaleSurface } from "@/lib/surface";
import type { AuctionSale } from "@/lib/types";
import { recordFeatureUsageEvent } from "@/lib/usage";

const SALES_STATISTICS_SOURCE_LIMIT = 1_000;

export type SalesStatisticsSegment = {
  key: string;
  label: string;
  count: number;
  sharePct: number;
  medianPriceEur: number | null;
  medianPricePerM2: number | null;
};

export type SalesStatisticsSummary = {
  sampleSize: number;
  capped: boolean;
  medianPriceEur: number | null;
  averagePriceEur: number | null;
  medianPricePerM2: number | null;
  averagePricePerM2: number | null;
  averageInvestmentScore: number | null;
  medianInvestmentScore: number | null;
  upcomingSales: number;
  adjudicatedSales: number;
  dpeKnownCount: number;
  dpeCounts: Record<DpeClass, number>;
  averageGrossYieldPct: number | null;
  medianGrossYieldPct: number | null;
};

export type SalesStatisticsResponse = {
  summary: SalesStatisticsSummary;
  segments: {
    propertyTypes: SalesStatisticsSegment[];
    departments: SalesStatisticsSegment[];
    statuses: SalesStatisticsSegment[];
  };
  meta: {
    generatedAt: string;
    sourceLimit: number;
    filters: Record<string, string | number | boolean | undefined>;
  };
};

export async function getSalesStatistics({
  auth,
  search,
}: {
  auth: SupabaseAuthContext;
  search: SalesSearchParams;
}): Promise<SalesStatisticsResponse> {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "sales.statistics")) {
    throw new Error("Statistiques immobilières réservées au plan Analyse.");
  }

  const center = search.aroundAddress ? await geocodeAddress(search.aroundAddress) : null;
  const sourceSales = await getSales(
    dataFiltersFromSearch(search),
    SALES_STATISTICS_SOURCE_LIMIT,
    dataSortFromSearch(search.sort),
    0,
    { client: auth.supabase },
  );
  const filteredSales = sortClientSearchResults(
    applyClientSearchFilters(sourceSales, search, center),
    search,
    center,
  );
  const response = buildSalesStatisticsResponse({
    sales: filteredSales,
    capped: sourceSales.length >= SALES_STATISTICS_SOURCE_LIMIT,
    search,
  });

  await recordFeatureUsageEvent({
    auth,
    eventKey: "sales.statistics_viewed",
    subjectType: "sale_search",
    metadata: {
      sample_size: response.summary.sampleSize,
      capped: response.summary.capped,
      filters: response.meta.filters,
    },
  });

  return response;
}

export function buildSalesStatisticsResponse({
  sales,
  capped,
  search,
  now = new Date(),
}: {
  sales: AuctionSale[];
  capped: boolean;
  search: SalesSearchParams;
  now?: Date;
}): SalesStatisticsResponse {
  return {
    summary: buildSalesStatisticsSummary(sales, capped, now),
    segments: {
      propertyTypes: buildSegments(sales, (sale) => sale.property_type, "Non renseigné"),
      departments: buildSegments(sales, (sale) => sale.department, "Non renseigné"),
      statuses: buildSegments(sales, (sale) => sale.status, "Non renseigné"),
    },
    meta: {
      generatedAt: now.toISOString(),
      sourceLimit: SALES_STATISTICS_SOURCE_LIMIT,
      filters: salesSearchToUrlRecord(search),
    },
  };
}

export function buildSalesStatisticsSummary(
  sales: AuctionSale[],
  capped = false,
  now = new Date(),
): SalesStatisticsSummary {
  const prices = sales.map((sale) => sale.starting_price_eur).filter(isPositiveNumber);
  const pricePerM2Values = sales
    .map((sale) => pricePerM2(sale.starting_price_eur, getSaleSurface(sale).value))
    .filter(isPositiveNumber);
  const scores = sales.map((sale) => sale.investment_score).filter(isFiniteNumber);
  const yields = sales
    .map((sale) =>
      estimateGrossYieldPct(sale.starting_price_eur, getSaleSurface(sale).value, sale.department),
    )
    .filter(isPositiveNumber);
  const dpeCounts = emptyDpeCounts();
  let dpeKnownCount = 0;
  let upcomingSales = 0;
  let adjudicatedSales = 0;

  for (const sale of sales) {
    const dpe = extractDpe(sale).class;
    if (dpe) {
      dpeCounts[dpe] += 1;
      dpeKnownCount += 1;
    }
    if (sale.sale_date && Date.parse(sale.sale_date) >= now.getTime()) upcomingSales += 1;
    if (isAdjudicatedStatus(sale.status) || isPositiveNumber(sale.adjudication_price_eur)) {
      adjudicatedSales += 1;
    }
  }

  return {
    sampleSize: sales.length,
    capped,
    medianPriceEur: medianRounded(prices),
    averagePriceEur: averageRounded(prices),
    medianPricePerM2: medianRounded(pricePerM2Values),
    averagePricePerM2: averageRounded(pricePerM2Values),
    averageInvestmentScore: averageRounded(scores),
    medianInvestmentScore: medianRounded(scores),
    upcomingSales,
    adjudicatedSales,
    dpeKnownCount,
    dpeCounts,
    averageGrossYieldPct: averageRounded(yields, 1),
    medianGrossYieldPct: medianRounded(yields, 1),
  };
}

function buildSegments(
  sales: AuctionSale[],
  pick: (sale: AuctionSale) => string | null | undefined,
  fallback: string,
): SalesStatisticsSegment[] {
  const groups = new Map<string, AuctionSale[]>();
  for (const sale of sales) {
    const key = cleanSegmentValue(pick(sale)) ?? fallback;
    groups.set(key, [...(groups.get(key) ?? []), sale]);
  }

  return [...groups.entries()]
    .map(([key, items]) => {
      const prices = items.map((sale) => sale.starting_price_eur).filter(isPositiveNumber);
      const pricePerM2Values = items
        .map((sale) => pricePerM2(sale.starting_price_eur, getSaleSurface(sale).value))
        .filter(isPositiveNumber);
      return {
        key,
        label: key,
        count: items.length,
        sharePct: sales.length ? round((items.length / sales.length) * 100, 1) : 0,
        medianPriceEur: medianRounded(prices),
        medianPricePerM2: medianRounded(pricePerM2Values),
      };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 8);
}

function emptyDpeCounts(): Record<DpeClass, number> {
  return DPE_CLASSES.reduce(
    (acc, dpeClass) => {
      acc[dpeClass] = 0;
      return acc;
    },
    {} as Record<DpeClass, number>,
  );
}

function isAdjudicatedStatus(status: string | null): boolean {
  return Boolean(status && /adjud|sold|pass/i.test(status));
}

function cleanSegmentValue(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text || null;
}

function averageRounded(values: number[], digits = 0): number | null {
  if (!values.length) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length, digits);
}

function medianRounded(values: number[], digits = 0): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return round(value, digits);
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveNumber(value: number | null | undefined): value is number {
  return isFiniteNumber(value) && value > 0;
}
