import { getSales, getSalesCount, getSalesForSearch, getSaleMapPoints } from "@/lib/queries";
import { supabase } from "@/integrations/supabase/client";
import { geocodeAddress } from "@/lib/geo";
import type { AuctionSale } from "@/lib/types";
import { excludeHomepageExampleSales } from "@/lib/example-sale-identity";
import {
  previewSearchRequestKey,
  runPreviewSearch,
  type PreviewRpcClient,
  type PreviewSearchResponse,
} from "./preview-search";
import type { SalesSearchParams } from "./search-url-state";
import {
  applyClientSearchFilters,
  sortClientSearchResults,
  hasClientOnlyFilters,
  DEFAULT_SEARCH_LIMIT,
  MAX_MAP_RESULTS,
  dataFiltersFromSearch,
  dataSortFromSearch,
} from "./search-filters";

const inFlightPreviewSearches = new Map<string, Promise<PreviewSearchResponse>>();

export async function fetchSearchResults({
  search,
  preview,
  discovery = false,
}: {
  search: SalesSearchParams;
  preview: boolean;
  discovery?: boolean;
}): Promise<AuctionSale[]> {
  if (preview) return excludeHomepageExampleSales((await fetchPreviewSearch(search)).items);

  if (hasClientOnlyFilters(search)) {
    const rows = await fetchCompleteFilteredSearch(search, discovery);
    const start = ((search.page ?? 1) - 1) * (search.limit ?? DEFAULT_SEARCH_LIMIT);
    return rows.slice(start, start + (search.limit ?? DEFAULT_SEARCH_LIMIT));
  }
  const page = search.page ?? 1;
  const perPage = search.limit ?? DEFAULT_SEARCH_LIMIT;
  const offset = (page - 1) * perPage;
  return excludeHomepageExampleSales(
    await getSalesForSearch(
      dataFiltersFromSearch(search),
      perPage,
      dataSortFromSearch(search.sort),
      offset,
      { discovery },
    ),
  );
}

export async function fetchSearchCount({
  search,
  preview,
  discovery = false,
}: {
  search: SalesSearchParams;
  preview: boolean;
  discovery?: boolean;
}): Promise<number> {
  if (preview) return (await fetchPreviewSearch(search)).count;

  if (hasClientOnlyFilters(search))
    return (await fetchCompleteFilteredSearch(search, discovery)).length;
  const filters = dataFiltersFromSearch(search);
  return getSalesCount(filters, { discovery });
}

export async function fetchSearchMapResults(
  search: SalesSearchParams,
  options: { discovery?: boolean } = {},
): Promise<AuctionSale[]> {
  if (hasClientOnlyFilters(search))
    return (await fetchCompleteFilteredSearch(search, options.discovery ?? false))
      .filter((sale) => sale.latitude != null && sale.longitude != null)
      .slice(0, MAX_MAP_RESULTS);
  // Tous les points de la recherche (identifiant, position, prix), pas un échantillon de 300.
  return excludeHomepageExampleSales(
    await getSaleMapPoints(dataFiltersFromSearch(search), options),
  );
}

function fetchPreviewSearch(search: SalesSearchParams): Promise<PreviewSearchResponse> {
  const requestKey = previewSearchRequestKey(search);
  const currentRequest = inFlightPreviewSearches.get(requestKey);
  if (currentRequest) return currentRequest;

  const request = runPreviewSearch(supabase as unknown as PreviewRpcClient, search).finally(() =>
    inFlightPreviewSearches.delete(requestKey),
  );

  inFlightPreviewSearches.set(requestKey, request);
  return request;
}

// Share one complete, bounded scan between the list, count and map. Filtering
// precedes pagination so an advanced criterion cannot hide matches on later pages.
const completeSearches = new Map<string, Promise<AuctionSale[]>>();
async function fetchCompleteFilteredSearch(search: SalesSearchParams, discovery: boolean) {
  const criteria = { ...search, page: undefined, limit: undefined };
  const key = JSON.stringify([criteria, discovery]);
  const existing = completeSearches.get(key);
  if (existing) return existing;
  const request = (async () => {
    const center = search.aroundAddress ? await geocodeAddress(search.aroundAddress) : null;
    if (search.aroundAddress && !center)
      throw new Error("Localisation introuvable. Précisez la ville ou l’adresse.");
    const rows: AuctionSale[] = [];
    const batchSize = 100;
    for (let offset = 0; offset < 10000; offset += batchSize) {
      // Advanced client-side filters need fields intentionally omitted from
      // the lightweight card projection (DPE, visits, documents, evidence).
      const batch = await getSales(
        dataFiltersFromSearch(criteria),
        batchSize,
        dataSortFromSearch(search.sort),
        offset,
        { discovery },
      );
      rows.push(...batch);
      if (batch.length < batchSize)
        return sortClientSearchResults(
          applyClientSearchFilters(excludeHomepageExampleSales(rows), search, center),
          search,
          center,
        );
    }
    throw new Error(
      "Cette recherche est trop large. Choisissez une région ou un département pour appliquer les filtres avancés.",
    );
  })().finally(() => completeSearches.delete(key));
  completeSearches.set(key, request);
  return request;
}
