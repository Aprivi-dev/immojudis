import type { Database } from "@/integrations/supabase/types";
import { isLikelyPropertyImageUrl } from "@/lib/sale-media";
import type { AuctionSale } from "@/lib/types";
import { departmentSearchValues, frenchSearchTerms } from "./french-geo-search";
import { DEFAULT_SEARCH_LIMIT, dataFiltersFromSearch, dataSortFromSearch } from "./search-filters";
import type { SalesSearchParams } from "./search-url-state";

/**
 * Public (anonymous) catalogue search. This module is shared by the browser
 * (React Query) and by the server (first paint of /sales): both call the same
 * RPC with the same arguments, so the server HTML and the hydrated client agree.
 */
export type PreviewSearchResponse = {
  items: AuctionSale[];
  count: number;
};

type GeneratedPreviewSearchRow =
  Database["public"]["Functions"]["search_auction_sales_preview_v3"]["Returns"][number];

/**
 * Le générateur de types déclare les colonnes de `RETURNS TABLE` non nulles ; la miniature
 * peut pourtant être absente, et `mapPreviewRows` la filtre.
 */
export type PreviewSearchRow = Omit<GeneratedPreviewSearchRow, "thumbnail_url"> & {
  thumbnail_url: string | null;
};

/** Minimal surface of a Supabase client needed to run the public search RPC. */
export type PreviewRpcClient = {
  rpc: (
    fn: "search_auction_sales_preview_v3" | "search_auction_sales_preview_v4",
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

export function buildPreviewSearchArgs(search: SalesSearchParams) {
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
  return {
    p_departments: departments,
    p_city: filters.city ?? null,
    p_postal_code: filters.postal_code ?? null,
    p_tribunal: filters.tribunal ?? null,
    p_sale_venue_type: filters.sale_venue_type ?? null,
    p_keywords: filters.keywords ? frenchSearchTerms(filters.keywords).slice(0, 5) : null,
    p_property_types: propertyTypes,
    p_min_price: filters.min_price ?? null,
    p_max_price: filters.max_price ?? null,
    p_min_surface: filters.min_surface ?? null,
    p_max_surface: filters.max_surface ?? null,
    p_min_bedrooms: filters.min_bedrooms ?? null,
    p_min_bathrooms: filters.min_bathrooms ?? null,
    // Private analyses and exact locations remain outside the public contract.
    p_occupancy_status: null,
    p_min_score: null,
    p_statuses: filters.status_in ?? null,
    p_north: null,
    p_south: null,
    p_east: null,
    p_west: null,
    p_sort: dataSortFromSearch(search.sort),
    p_limit: perPage,
    p_offset: (page - 1) * perPage,
  };
}

export function previewSearchRequestKey(search: SalesSearchParams): string {
  return JSON.stringify([buildPreviewSearchArgs(search), search.minSaleDate, search.maxSaleDate]);
}

export function mapPreviewRows(rows: PreviewSearchRow[]): AuctionSale[] {
  return rows.map((row) => ({
    id: row.id,
    starting_price_eur: row.starting_price_eur,
    sale_venue_type: row.sale_venue_type,
    sale_verification_status: row.sale_verification_status,
    city: row.city,
    department: row.department,
    property_type: row.property_type,
    sale_date: row.sale_date,
    app_surface_m2: row.app_surface_m2,
    app_surface_kind: row.app_surface_kind,
    rooms_count: row.rooms_count,
    bedrooms_count: row.bedrooms_count,
    bathrooms_count: row.bathrooms_count,
    latitude: row.latitude,
    longitude: row.longitude,
    media: isLikelyPropertyImageUrl(row.thumbnail_url)
      ? [{ type: "image", url: row.thumbnail_url }]
      : [],
  })) as AuctionSale[];
}

export async function runPreviewSearch(
  client: PreviewRpcClient,
  search: SalesSearchParams,
): Promise<PreviewSearchResponse> {
  const args = buildPreviewSearchArgs(search);
  const { data, error } = await (search.minSaleDate || search.maxSaleDate
    ? client.rpc("search_auction_sales_preview_v4", {
        ...args,
        p_min_sale_date: search.minSaleDate ?? null,
        p_max_sale_date: search.maxSaleDate ?? null,
      })
    : client.rpc("search_auction_sales_preview_v3", args));
  if (error) throw error;
  const rows = (data ?? []) as PreviewSearchRow[];
  return {
    items: mapPreviewRows(rows),
    count: Number(rows[0]?.total_count ?? 0),
  };
}
