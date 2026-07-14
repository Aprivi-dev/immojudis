import { getSales, getSalesCount, getSalesWithCoords } from "@/lib/queries";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import type { AuctionSale } from "@/lib/types";
import { departmentSearchValues, frenchSearchTerms } from "./french-geo-search";
import type { SalesSearchParams } from "./search-url-state";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_MAP_RESULTS,
  dataFiltersFromSearch,
  dataSortFromSearch,
} from "./search-filters";

type PreviewSearchResponse = {
  items: AuctionSale[];
  count: number;
};

type PreviewSearchRow =
  Database["public"]["Functions"]["search_auction_sales_preview"]["Returns"][number];

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
  if (preview) return (await fetchPreviewSearch(search)).items;

  const page = search.page ?? 1;
  const perPage = search.limit ?? DEFAULT_SEARCH_LIMIT;
  const limit = page * perPage;
  return getSales(dataFiltersFromSearch(search), limit, dataSortFromSearch(search.sort), 0, {
    discovery,
  });
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

  const filters = dataFiltersFromSearch(search);
  return getSalesCount(filters, { discovery });
}

export async function fetchSearchMapResults(
  search: SalesSearchParams,
  options: { discovery?: boolean } = {},
): Promise<AuctionSale[]> {
  return getSalesWithCoords(
    dataFiltersFromSearch(search),
    MAX_MAP_RESULTS,
    dataSortFromSearch(search.sort),
    options,
  );
}

async function fetchPreviewSearch(search: SalesSearchParams): Promise<PreviewSearchResponse> {
  const filters = dataFiltersFromSearch(search);
  const page = search.page ?? 1;
  const perPage = search.limit ?? DEFAULT_SEARCH_LIMIT;
  const departments = filters.departments?.length
    ? departmentSearchValues(filters.departments)
    : filters.department
      ? [filters.department]
      : null;
  const propertyTypes = filters.property_types?.length
    ? filters.property_types
    : filters.property_type
      ? [filters.property_type]
      : null;
  const args = {
    p_departments: departments,
    p_city: filters.city ?? null,
    p_postal_code: filters.postal_code ?? null,
    p_tribunal: filters.tribunal ?? null,
    p_keywords: filters.keywords ? frenchSearchTerms(filters.keywords).slice(0, 12) : null,
    p_property_types: propertyTypes,
    p_min_price: filters.min_price ?? null,
    p_max_price: filters.max_price ?? null,
    p_min_surface: filters.min_surface ?? null,
    p_max_surface: filters.max_surface ?? null,
    p_min_bedrooms: filters.min_bedrooms ?? null,
    p_min_bathrooms: filters.min_bathrooms ?? null,
    p_occupancy_status: filters.occupancy_status ?? null,
    p_min_score: filters.min_score ?? null,
    p_statuses: filters.status_in ?? null,
    p_north: filters.viewport?.north ?? null,
    p_south: filters.viewport?.south ?? null,
    p_east: filters.viewport?.east ?? null,
    p_west: filters.viewport?.west ?? null,
    p_sort: dataSortFromSearch(search.sort),
    p_limit: page * perPage,
    p_offset: 0,
  };
  const requestKey = JSON.stringify(args);
  const currentRequest = inFlightPreviewSearches.get(requestKey);
  if (currentRequest) return currentRequest;

  const request = Promise.resolve(supabase.rpc("search_auction_sales_preview", args))
    .then(({ data, error }) => {
      if (error) throw error;
      const rows = (data ?? []) as PreviewSearchRow[];
      return {
        items: rows.map((row) => ({
          id: row.id,
          starting_price_eur: row.starting_price_eur,
        })) as AuctionSale[],
        count: Number(rows[0]?.total_count ?? 0),
      };
    })
    .finally(() => inFlightPreviewSearches.delete(requestKey));

  inFlightPreviewSearches.set(requestKey, request);
  return request;
}
