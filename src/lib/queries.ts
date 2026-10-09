import { saleDateBoundary } from "./search/sale-date-range";
import { supabase } from "@/integrations/supabase/client";
import { departmentSearchValues, frenchSearchTerms } from "@/lib/search/french-geo-search";
import type { AuctionSale, SaleFilters, SortKey } from "./types";
import { DETAIL_VIEW, SALE_LIST_COLUMNS } from "./sale-views";
import { assertCloudConfigured } from "./query-configuration";
import { sanitizeAuctionSaleForDisplay } from "./listing-data-cleanup";
export { createAlert, deleteAlert, getAlerts, updateAlert } from "./alert-queries";
export type { CreateAlertPayload } from "./alert-queries";
export { DETAIL_VIEW, SALE_LIST_COLUMNS };

const DISCOVERY_VIEW = "v_auction_sales_discovery" as typeof DETAIL_VIEW;
const SEARCH_VIEW = "v_auction_sales_app_search" as typeof DETAIL_VIEW;
const DISCOVERY_SEARCH_VIEW = "v_auction_sales_discovery_search" as typeof DETAIL_VIEW;
const PUBLIC_PREVIEW_VIEW = "v_auction_sales_app_preview";

type SupabaseQueryError = {
  code?: string;
  message?: string;
  details?: string;
};

type SupabaseReader = Pick<typeof supabase, "from">;

// Fields needed by the search result card only. Keep heavy descriptions,
// documents, source payloads and analysis evidence on the detail route.
export const SALE_CARD_COLUMNS = [
  "sale_venue_type",
  "sale_legal_framework",
  "sale_verification_status",
  "id",
  "title",
  "city",
  "department",
  "address",
  "tribunal",
  "tribunal_name",
  "tribunal_city",
  "property_type",
  "starting_price_eur",
  "sale_date",
  "latitude",
  "longitude",
  "occupancy_status",
  "habitable_surface_m2",
  "carrez_surface_m2",
  "app_surface_m2",
  "app_surface_kind",
  "surface_scope",
  "rooms_count",
  "bedrooms_count",
  "bathrooms_count",
  "investment_score",
  "risks",
  "media",
  "status",
].join(",");

const SALE_PREVIEW_COLUMNS = [
  "id",
  "starting_price_eur",
  "sale_venue_type",
  "sale_verification_status",
].join(",");

// Pins use only scalar catalogue fields. The selected popup fetches its
// photos, risk and DPE evidence separately, through the same access-controlled view.
const SALE_MAP_COLUMNS = [
  "sale_venue_type",
  "sale_legal_framework",
  "sale_verification_status",
  "id",
  "title",
  "city",
  "department",
  "postal_code",
  "address",
  "tribunal",
  "tribunal_name",
  "tribunal_city",
  "property_type",
  "starting_price_eur",
  "sale_date",
  "latitude",
  "longitude",
  "occupancy_status",
  "app_surface_m2",
  "habitable_surface_m2",
  "carrez_surface_m2",
  "land_surface_m2",
  "app_surface_kind",
  "surface_scope",
  "surface_source",
  "surface_confidence",
  "rooms_count",
  "bedrooms_count",
  "bathrooms_count",
  "has_garden",
  "has_terrace",
  "has_garage",
  "status",
  "investment_score",
  "created_at",
].join(",");

function isMissingPreviewViewError(error: SupabaseQueryError | null): boolean {
  if (!error) return false;
  const text = `${error.code ?? ""} ${error.message ?? ""} ${error.details ?? ""}`;
  return text.includes("PGRST205") || text.includes(PUBLIC_PREVIEW_VIEW);
}

function previewSortDirection(sort: SortKey): boolean {
  return sort === "price_desc" ? false : true;
}

async function getSalesFromLegacyPreview(
  filters: SaleFilters,
  limit: number,
  sort: SortKey,
  offset: number,
): Promise<AuctionSale[]> {
  let q = supabase
    .from(DETAIL_VIEW)
    .select(SALE_PREVIEW_COLUMNS)
    .order("starting_price_eur", { ascending: previewSortDirection(sort), nullsFirst: false })
    .range(offset, offset + limit - 1);

  q = applySaleTypeFilter(q, filters);
  if (filters.min_price != null) q = q.gte("starting_price_eur", filters.min_price);
  if (filters.max_price != null) q = q.lte("starting_price_eur", filters.max_price);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as AuctionSale[];
}

async function getSalePreviewFromLegacyView(id: string): Promise<AuctionSale | null> {
  const { data, error } = await supabase
    .from(DETAIL_VIEW)
    .select(SALE_PREVIEW_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data as unknown as AuctionSale | null;
}

async function getSalesPreviewCountFromLegacyView(filters: SaleFilters): Promise<number> {
  let q = supabase.from(DETAIL_VIEW).select("id", { count: "exact" }).range(0, 999);

  q = applySaleTypeFilter(q, filters);
  if (filters.min_price != null) q = q.gte("starting_price_eur", filters.min_price);
  if (filters.max_price != null) q = q.lte("starting_price_eur", filters.max_price);

  const { count, data, error } = await q;
  if (error) throw error;
  return count && count > 0 ? count : (data?.length ?? 0);
}

const SORT_MAP: Record<SortKey, { column: string; ascending: boolean; nullsFirst?: boolean }> = {
  date_asc: { column: "sale_date", ascending: true },
  date_desc: { column: "sale_date", ascending: false },
  price_asc: { column: "starting_price_eur", ascending: true },
  price_desc: { column: "starting_price_eur", ascending: false },
  score_desc: { column: "investment_score", ascending: false },
  surface_desc: { column: "app_surface_m2", ascending: false },
};

type FilterableQuery = {
  eq: (column: string, value: string | number | boolean) => FilterableQuery;
  gte: (column: string, value: string | number) => FilterableQuery;
  lte: (column: string, value: string | number) => FilterableQuery;
  in: (column: string, values: string[]) => FilterableQuery;
  ilike: (column: string, pattern: string) => FilterableQuery;
  or: (filters: string) => FilterableQuery;
};

function textPattern(value: string) {
  return `%${value.replace(/[,%().]/g, " ").trim()}%`;
}

function applyTextSearch(query: FilterableQuery, columns: string[], value: string | undefined) {
  if (!value?.trim()) return query;
  const terms = frenchSearchTerms(value).slice(0, 12);

  return terms.reduce((current, term) => {
    const alternatives = accentTolerantPatterns(term);
    return current.or(
      columns
        .flatMap((column) =>
          alternatives.map((pattern) => `${column}.ilike.${textPattern(pattern)}`),
        )
        .join(","),
    );
  }, query);
}

function accentTolerantPatterns(term: string): string[] {
  const patterns = [term];
  for (let index = 0; index < term.length && patterns.length < 8; index += 1) {
    if (!/[aeiouycn]/.test(term[index] ?? "")) continue;
    patterns.push(`${term.slice(0, index)}_${term.slice(index + 1)}`);
  }
  return patterns;
}

function applySaleTypeFilter<TQuery>(query: TQuery, filters: SaleFilters): TQuery {
  let q = query as unknown as FilterableQuery;
  if (filters.sale_venue_type === "unknown") {
    q = q.in("sale_venue_type", ["unknown", "online"]);
  } else if (filters.sale_venue_type) {
    q = q.eq("sale_venue_type", filters.sale_venue_type);
  }
  return q as unknown as TQuery;
}

function applyAuthenticatedSaleFilters<TQuery>(query: TQuery, filters: SaleFilters) {
  let q = applySaleTypeFilter(query, filters) as unknown as FilterableQuery;

  if (filters.min_sale_date) q = q.gte("sale_date", saleDateBoundary(filters.min_sale_date));
  if (filters.max_sale_date) q = q.lte("sale_date", saleDateBoundary(filters.max_sale_date, true));
  if (filters.department) q = q.eq("department", filters.department);
  if (filters.departments?.length) {
    q = q.in("department", departmentSearchValues(filters.departments));
  }
  if (filters.city) q = q.ilike("city", textPattern(filters.city));
  if (filters.postal_code) q = q.eq("postal_code", filters.postal_code);
  if (filters.property_type) q = q.eq("property_type", filters.property_type);
  if (filters.property_types?.length) q = q.in("property_type", filters.property_types);
  if (filters.min_price != null) q = q.gte("starting_price_eur", filters.min_price);
  if (filters.max_price != null) q = q.lte("starting_price_eur", filters.max_price);
  if (filters.min_surface != null) q = q.gte("app_surface_m2", filters.min_surface);
  if (filters.max_surface != null) q = q.lte("app_surface_m2", filters.max_surface);
  if (filters.min_bedrooms != null) q = q.gte("bedrooms_count", filters.min_bedrooms);
  if (filters.min_bathrooms != null) q = q.gte("bathrooms_count", filters.min_bathrooms);
  if (filters.occupancy_status) {
    // Match the same historical aliases as occupancyLabel, before count/pagination.
    const occupancy = filters.occupancy_status.toLowerCase();
    if (["free", "vacant", "libre"].includes(occupancy)) {
      q = q.or(
        "occupancy_status.ilike.%libre%,occupancy_status.ilike.vacant,occupancy_status.ilike.free",
      );
    } else if (["occupied", "occupé", "occupe"].includes(occupancy)) {
      q = q.ilike("occupancy_status", "%occup%");
    } else if (["rented", "loué", "loue"].includes(occupancy)) {
      q = q.or(
        "occupancy_status.ilike.%loué%,occupancy_status.ilike.%loue%,occupancy_status.ilike.%rented%",
      );
    } else q = q.eq("occupancy_status", filters.occupancy_status);
  }
  if (filters.min_score != null) q = q.gte("investment_score", filters.min_score);
  if (filters.tribunal_code) q = q.eq("tribunal_code", filters.tribunal_code);
  if (filters.status_in?.length) q = q.in("status", filters.status_in);
  if (filters.viewport) {
    q = q
      .gte("latitude", filters.viewport.south)
      .lte("latitude", filters.viewport.north)
      .gte("longitude", filters.viewport.west)
      .lte("longitude", filters.viewport.east);
  }
  if (filters.only_new) {
    q = q.gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
  }
  q = applyTextSearch(
    q,
    ["tribunal", "tribunal_name", "tribunal_city", "tribunal_code"],
    filters.tribunal,
  );
  q = applyTextSearch(
    q,
    [
      "title",
      "description",
      "source_description",
      "city",
      "department",
      "postal_code",
      "address",
      "tribunal",
      "tribunal_name",
      "tribunal_city",
      "tribunal_code",
    ],
    filters.keywords,
  );

  return q as unknown as TQuery;
}

const SALE_ID_BATCH_SIZE = 100;
const SALE_ID_BATCH_CONCURRENCY = 4;

function uniqueSaleIds(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return Array.from(
    new Set(
      data
        .map((row) => (row as { id?: unknown })?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
}

function orderSalesByIds(rows: AuctionSale[], ids: string[]): AuctionSale[] {
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = rowsById.get(id);
    return row ? [row] : [];
  });
}

async function fetchSaleRowsByIds(
  db: SupabaseReader,
  catalogView: typeof DETAIL_VIEW,
  columns: string,
  filters: SaleFilters,
  ids: string[],
): Promise<AuctionSale[]> {
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += SALE_ID_BATCH_SIZE) {
    batches.push(ids.slice(index, index + SALE_ID_BATCH_SIZE));
  }

  const rows: AuctionSale[] = [];
  for (let index = 0; index < batches.length; index += SALE_ID_BATCH_CONCURRENCY) {
    const batchRows = await Promise.all(
      batches.slice(index, index + SALE_ID_BATCH_CONCURRENCY).map(async (batch) => {
        let q = db.from(catalogView).select(columns);
        q = applyAuthenticatedSaleFilters(q, filters);
        const { data, error } = await q.in("id", batch);
        if (error) throw error;
        return (data ?? []) as unknown as AuctionSale[];
      }),
    );
    rows.push(...batchRows.flat());
  }

  return rows;
}

async function fetchSearchResultIds(
  db: SupabaseReader,
  catalogView: typeof DETAIL_VIEW,
  filters: SaleFilters,
  limit: number,
  sort: SortKey,
  offset: number,
): Promise<string[]> {
  const s = SORT_MAP[sort];
  let q = db
    .from(catalogView)
    .select("id")
    .order("coordinates_rank", { ascending: true })
    .order(s.column, { ascending: s.ascending, nullsFirst: false })
    .range(offset, offset + limit - 1);
  q = applyAuthenticatedSaleFilters(q, filters);

  const { data, error } = await q;
  if (error) throw error;
  return uniqueSaleIds(data);
}

export async function getSales(
  filters: SaleFilters = {},
  limit = 100,
  sort: SortKey = "date_asc",
  offset = 0,
  options: { preview?: boolean; discovery?: boolean; client?: SupabaseReader } = {},
): Promise<AuctionSale[]> {
  if (!options.client && !assertCloudConfigured()) return [];
  const db = options.client ?? supabase;

  if (options.preview) {
    let q = db
      .from(PUBLIC_PREVIEW_VIEW)
      .select(SALE_PREVIEW_COLUMNS)
      .order("starting_price_eur", { ascending: previewSortDirection(sort), nullsFirst: false })
      .range(offset, offset + limit - 1);

    q = applySaleTypeFilter(q, filters);
    if (filters.min_price != null) q = q.gte("starting_price_eur", filters.min_price);
    if (filters.max_price != null) q = q.lte("starting_price_eur", filters.max_price);

    const { data, error } = await q;
    if (isMissingPreviewViewError(error)) {
      return getSalesFromLegacyPreview(filters, limit, sort, offset);
    }
    if (error) throw error;
    return (data ?? []) as unknown as AuctionSale[];
  }

  const s = SORT_MAP[sort];
  const catalogView = options.discovery ? DISCOVERY_SEARCH_VIEW : SEARCH_VIEW;
  let q = db
    .from(catalogView)
    .select(SALE_LIST_COLUMNS)
    .order("coordinates_rank", { ascending: true })
    .order(s.column, { ascending: s.ascending, nullsFirst: false })
    .range(offset, offset + limit - 1);

  q = applyAuthenticatedSaleFilters(q, filters);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as AuctionSale[];
}

export async function getSalesForSearch(
  filters: SaleFilters = {},
  limit = 100,
  sort: SortKey = "date_asc",
  offset = 0,
  options: { discovery?: boolean; client?: SupabaseReader } = {},
): Promise<AuctionSale[]> {
  if (!options.client && !assertCloudConfigured()) return [];

  const s = SORT_MAP[sort];
  const db = options.client ?? supabase;
  const catalogView = options.discovery ? DISCOVERY_SEARCH_VIEW : SEARCH_VIEW;

  // The discovery view is a security barrier. EXPLAIN shows that selecting
  // IDs and then re-reading the barrier doubles its materialization cost, so
  // keep its existing single request. The app search view is invoker-safe and
  // can prune the heavy lateral projections when the first request selects
  // only IDs.
  if (!options.discovery) {
    const ids = await fetchSearchResultIds(db, catalogView, filters, limit, sort, offset);
    if (ids.length === 0) return [];
    const rows = await fetchSaleRowsByIds(db, catalogView, SALE_CARD_COLUMNS, filters, ids);
    return orderSalesByIds(rows, ids);
  }

  let q = db
    .from(catalogView)
    .select(SALE_CARD_COLUMNS)
    .order("coordinates_rank", { ascending: true })
    .order(s.column, { ascending: s.ascending, nullsFirst: false })
    .range(offset, offset + limit - 1);

  q = applyAuthenticatedSaleFilters(q, filters);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as AuctionSale[];
}

export async function getSalesCount(
  filters: SaleFilters = {},
  options: { discovery?: boolean } = {},
): Promise<number> {
  if (!assertCloudConfigured()) return 0;
  const catalogView = options.discovery ? DISCOVERY_VIEW : DETAIL_VIEW;
  let q = supabase.from(catalogView).select("id", { count: "exact", head: true });

  q = applyAuthenticatedSaleFilters(q, filters);

  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

export async function getSalesPreviewCount(filters: SaleFilters = {}): Promise<number> {
  if (!assertCloudConfigured()) return 0;
  let q = supabase.from(PUBLIC_PREVIEW_VIEW).select("id", { count: "exact", head: true });

  q = applySaleTypeFilter(q, filters);
  if (filters.min_price != null) q = q.gte("starting_price_eur", filters.min_price);
  if (filters.max_price != null) q = q.lte("starting_price_eur", filters.max_price);

  const { count, error } = await q;
  if (isMissingPreviewViewError(error)) {
    return getSalesPreviewCountFromLegacyView(filters);
  }
  if (error) throw error;
  return count ?? 0;
}

export async function getSaleById(
  id: string,
  options: { discovery?: boolean } = {},
): Promise<AuctionSale | null> {
  if (!assertCloudConfigured()) return null;
  if (typeof window === "undefined") return null;
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;
  const catalogView = options.discovery ? DISCOVERY_VIEW : DETAIL_VIEW;
  const { data, error } = await supabase.from(catalogView).select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? sanitizeAuctionSaleForDisplay(data as AuctionSale) : null;
}

export async function getSalePreviewById(id: string): Promise<AuctionSale | null> {
  if (!assertCloudConfigured()) return null;
  const { data, error } = await supabase
    .from(PUBLIC_PREVIEW_VIEW)
    .select(SALE_PREVIEW_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (isMissingPreviewViewError(error)) return getSalePreviewFromLegacyView(id);
  if (error) throw error;
  return data as unknown as AuctionSale | null;
}

export async function getSalesWithCoords(
  filters: SaleFilters = {},
  limit = 500,
  sort: SortKey = "date_asc",
  options: { discovery?: boolean; client?: SupabaseReader } = {},
): Promise<AuctionSale[]> {
  if (!options.client && !assertCloudConfigured()) return [];
  const s = SORT_MAP[sort];
  const db = options.client ?? supabase;
  const catalogView = options.discovery ? DISCOVERY_VIEW : DETAIL_VIEW;

  let q = db
    .from(catalogView)
    .select(SALE_MAP_COLUMNS)
    .not("latitude", "is", null)
    .not("longitude", "is", null)
    .order(s.column, { ascending: s.ascending, nullsFirst: false })
    .limit(limit);

  q = applyAuthenticatedSaleFilters(q, filters);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as AuctionSale[];
}

/**
 * Fetch sales within a bounding box around (lat,lng).
 * radiusKm is the half-side of the bbox; the caller is expected to filter
 * by exact haversine distance afterwards if needed.
 */
export async function getNearbySales(
  lat: number,
  lng: number,
  radiusKm: number,
  excludeId?: string,
  limit = 50,
): Promise<AuctionSale[]> {
  if (!assertCloudConfigured()) return [];
  // 1° latitude ≈ 111 km. 1° longitude ≈ 111 km × cos(lat).
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  let q = supabase
    .from(DETAIL_VIEW)
    .select(SALE_LIST_COLUMNS)
    .gte("latitude", lat - dLat)
    .lte("latitude", lat + dLat)
    .gte("longitude", lng - dLng)
    .lte("longitude", lng + dLng)
    .order("sale_date", { ascending: true })
    .limit(limit);
  if (excludeId) q = q.neq("id", excludeId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as AuctionSale[];
}

export async function getStats(): Promise<{
  totalSales: number;
  departments: number;
  nextSale: string | null;
}> {
  if (!assertCloudConfigured()) return { totalSales: 0, departments: 0, nextSale: null };
  const { count, error } = await supabase
    .from(PUBLIC_PREVIEW_VIEW)
    .select("*", { count: "exact", head: true });
  let totalSales = count ?? 0;

  if (isMissingPreviewViewError(error)) {
    const { count: legacyCount, error: legacyError } = await supabase
      .from(DETAIL_VIEW)
      .select("id", { count: "exact", head: true });
    if (legacyError) throw legacyError;
    totalSales = legacyCount ?? 0;
  } else if (error) {
    throw error;
  }

  if (typeof window === "undefined") {
    return { totalSales, departments: 0, nextSale: null };
  }
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { totalSales, departments: 0, nextSale: null };
  const { data: deps } = await supabase
    .from(DISCOVERY_VIEW)
    .select("department")
    .not("department", "is", null)
    .limit(1000);
  const uniqueDeps = new Set(
    (deps ?? []).map((r: { department: string | null }) => r.department).filter(Boolean),
  );
  const { data: next } = await supabase
    .from(DISCOVERY_VIEW)
    .select("sale_date")
    .gte("sale_date", new Date().toISOString())
    .order("sale_date", { ascending: true })
    .limit(1);
  return {
    totalSales,
    departments: uniqueDeps.size,
    nextSale: next?.[0]?.sale_date ?? null,
  };
}

// Favorites
export async function getFavorites(userId: string): Promise<AuctionSale[]> {
  if (!assertCloudConfigured()) return [];
  const { data: favs, error } = await supabase
    .from("user_favorites")
    .select("sale_id")
    .eq("user_id", userId);
  if (error) throw error;
  const ids = (favs ?? []).map((f: { sale_id: string }) => f.sale_id);
  if (ids.length === 0) return [];
  const { data, error: e2 } = await supabase
    .from(DETAIL_VIEW)
    .select(SALE_LIST_COLUMNS)
    .in("id", ids);
  if (e2) throw e2;
  return (data ?? []) as unknown as AuctionSale[];
}

export async function getFavoriteIds(userId: string): Promise<Set<string>> {
  if (!assertCloudConfigured()) return new Set();
  const { data, error } = await supabase
    .from("user_favorites")
    .select("sale_id")
    .eq("user_id", userId);
  if (error) throw error;
  return new Set((data ?? []).map((r: { sale_id: string }) => r.sale_id));
}

export async function addFavorite(userId: string, saleId: string) {
  assertCloudConfigured();
  const { error } = await supabase
    .from("user_favorites")
    .insert({ user_id: userId, sale_id: saleId });
  if (error && !error.message.includes("duplicate")) throw error;
}

export async function removeFavorite(userId: string, saleId: string) {
  assertCloudConfigured();
  const { error } = await supabase
    .from("user_favorites")
    .delete()
    .eq("user_id", userId)
    .eq("sale_id", saleId);
  if (error) throw error;
}
