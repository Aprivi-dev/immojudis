import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { geocodeAddress } from "@/lib/geo";
import { createRentLookupSession } from "@/lib/rent-reference.server";
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
import type { AuctionSale } from "@/lib/types";
import { recordFeatureUsageEvent } from "@/lib/usage";
import { summarizeSalesSample, type SalesSampleSummary } from "@/lib/sales-statistics-summary";
import { ForbiddenError } from "@/lib/api-errors";

const SALES_STATISTICS_SOURCE_LIMIT = 1_000;

/** Les repères affichés par le panneau de la recherche, sur l'échantillon (au plus 1 000 ventes). */
export type SalesStatisticsSummary = SalesSampleSummary & {
  sampleSize: number;
  capped: boolean;
};

export type SalesStatisticsResponse = {
  summary: SalesStatisticsSummary;
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
  // Loyers de la carte ANIL à la commune, seulement pour le filtre « rendement minimal » : il trie
  // l'échantillon avant le calcul. Les repères affichés ne lisent aucun loyer.
  const sourceRents =
    search.minYield != null ? await createRentLookupSession().load(sourceSales) : undefined;
  const filteredSales = sortClientSearchResults(
    applyClientSearchFilters(sourceSales, search, center, { rents: sourceRents }),
    search,
    center,
  );
  const summary = buildSalesStatisticsSummary(
    filteredSales,
    sourceSales.length >= SALES_STATISTICS_SOURCE_LIMIT,
  );

  recordFeatureUsageEvent({
    auth,
    eventKey: "sales.statistics_viewed",
    subjectType: "sale_search",
    metadata: {
      sample_size: summary.sampleSize,
      capped: summary.capped,
      filters: salesSearchToUrlRecord(search),
    },
  });

  return { summary };
}

export function buildSalesStatisticsSummary(
  sales: AuctionSale[],
  capped = false,
): SalesStatisticsSummary {
  return { sampleSize: sales.length, capped, ...summarizeSalesSample(sales) };
}
