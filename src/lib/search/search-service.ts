import { getSales, getSalesCount, getSalesPreviewCount, getSalesWithCoords } from "@/lib/queries";
import type { AuctionSale } from "@/lib/types";
import type { SalesSearchParams } from "./search-url-state";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_MAP_RESULTS,
  dataFiltersFromSearch,
  dataSortFromSearch,
} from "./search-filters";

export async function fetchSearchResults({
  search,
  preview,
  discovery = false,
}: {
  search: SalesSearchParams;
  preview: boolean;
  discovery?: boolean;
}): Promise<AuctionSale[]> {
  const page = search.page ?? 1;
  const perPage = search.limit ?? DEFAULT_SEARCH_LIMIT;
  const limit = page * perPage;
  return getSales(dataFiltersFromSearch(search), limit, dataSortFromSearch(search.sort), 0, {
    preview,
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
  const filters = dataFiltersFromSearch(search);
  return preview ? getSalesPreviewCount(filters) : getSalesCount(filters, { discovery });
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
