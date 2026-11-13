import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { estimateSaleGrossYieldPct, geocodeAddress, pricePerM2 } from "@/lib/geo";
import type { RentLookup } from "@/lib/rent-reference";
import { RENT_ATTRIBUTION } from "@/lib/rent-source-notice";
import { createRentLookupSession, rentBasisOf, type RentBasis } from "@/lib/rent-reference.server";
import { featureIncluded } from "@/lib/plans";
import { resolvePlanEntitlements } from "@/lib/entitlements.server";
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
import { averageRounded, round } from "@/lib/rounding";
import {
  isPositiveNumber,
  medianRounded,
  summarizeSalesSample,
  type SalesSampleSummary,
} from "@/lib/sales-statistics-summary";
import { ForbiddenError } from "@/lib/api-errors";

const SALES_STATISTICS_SOURCE_LIMIT = 1_000;

type SalesStatisticsSegment = {
  key: string;
  label: string;
  count: number;
  sharePct: number;
  medianPriceEur: number | null;
  medianPricePerM2: number | null;
};

export type SalesStatisticsSummary = SalesSampleSummary & {
  sampleSize: number;
  capped: boolean;
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
    /** Mention de la carte des loyers de l'ANIL, à afficher avec les rendements moyens. */
    rentAttribution: string;
    /** Ce que les rendements de l'échantillon utilisent : carte de l'ANIL, repère départemental, ou les deux. */
    rentBasis: RentBasis;
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
    throw new ForbiddenError("Statistiques immobilières réservées à l’offre Analyse.");
  }

  const center = search.aroundAddress ? await geocodeAddress(search.aroundAddress) : null;
  // Le tri de l'URL s'applique aussi aux statistiques: par défaut (« Mieux renseignées d'abord »),
  // l'échantillon plafonné suit donc l'ordre par complétude puis par date.
  const sourceSales = await getSales(
    dataFiltersFromSearch(search),
    SALES_STATISTICS_SOURCE_LIMIT,
    dataSortFromSearch(search.sort, { allowInvestmentScore: true }),
    0,
    { client: auth.supabase },
  );
  // Loyers de la carte ANIL à la commune : sur l'échantillon quand le filtre « rendement minimal » doit
  // trier avant le calcul, sinon sur les seules ventes retenues.
  const rentSession = createRentLookupSession();
  const sourceRents = search.minYield != null ? await rentSession.load(sourceSales) : undefined;
  const filteredSales = sortClientSearchResults(
    applyClientSearchFilters(sourceSales, search, center, { rents: sourceRents }),
    search,
    center,
  );
  const response = buildSalesStatisticsResponse({
    sales: filteredSales,
    capped: sourceSales.length >= SALES_STATISTICS_SOURCE_LIMIT,
    search,
    rents: await rentSession.load(filteredSales),
  });

  recordFeatureUsageEvent({
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
  rents,
}: {
  sales: AuctionSale[];
  capped: boolean;
  search: SalesSearchParams;
  now?: Date;
  /** Références de loyer (carte ANIL à la commune) ; absentes, le loyer départemental sert de repli. */
  rents?: RentLookup;
}): SalesStatisticsResponse {
  return {
    summary: buildSalesStatisticsSummary(sales, capped, now, rents),
    segments: {
      propertyTypes: buildSegments(sales, (sale) => sale.property_type, "Non renseigné"),
      departments: buildSegments(sales, (sale) => sale.department, "Non renseigné"),
      statuses: buildSegments(sales, (sale) => sale.status, "Non renseigné"),
    },
    meta: {
      generatedAt: now.toISOString(),
      sourceLimit: SALES_STATISTICS_SOURCE_LIMIT,
      filters: salesSearchToUrlRecord(search),
      // Mention obligatoire de la carte des loyers derrière les rendements moyens (voir `RentSourceNotice`).
      rentAttribution: RENT_ATTRIBUTION,
      rentBasis: rentBasisOf(sales, rents),
    },
  };
}

export function buildSalesStatisticsSummary(
  sales: AuctionSale[],
  capped = false,
  now = new Date(),
  rents?: RentLookup,
): SalesStatisticsSummary {
  const yields = sales
    .map((sale) => estimateSaleGrossYieldPct(sale, getSaleSurface(sale).value, rents?.(sale)))
    .filter(isPositiveNumber);

  return {
    sampleSize: sales.length,
    capped,
    ...summarizeSalesSample(sales, now),
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

function cleanSegmentValue(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text || null;
}
