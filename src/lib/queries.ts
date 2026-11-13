import { saleDateBoundary } from "./search/sale-date-range";
import { getSupabase, type SupabaseBrowserClient } from "@/integrations/supabase/lazy";
import { departmentSearchValues, frenchSearchTerms } from "@/lib/search/french-geo-search";
import { occupancyClassCodes } from "@/lib/occupancy-filter";
import { occupancyClass } from "@/lib/occupancy-status";
import type { AuctionSale, SaleFilters, SortKey } from "./types";
import {
  ALERT_DETAIL_COLUMNS,
  ALERT_EVALUATION_COLUMNS,
  DETAIL_VIEW,
  DISCOVERY_VIEW as DISCOVERY_VIEW_NAME,
  SALE_LIST_COLUMNS,
  SEARCH_DETAIL_COLUMNS,
  SEARCH_SCAN_COLUMNS,
  UNLOCKED_VIEW,
} from "./sale-views";
import { assertCloudConfigured } from "./query-configuration";
import { sanitizeAuctionSaleForDisplay } from "./listing-data-cleanup";
import { fetchPublicSaleSummary } from "./public-sale-summary";
import { saleRows } from "./sale-rows";
import { readPagedRows } from "./paged-read";
import {
  PHOTO_MIRROR_BROWSER_TIMEOUT_MS,
  withPhotoMirror,
  type PhotoMirrorClient,
} from "./photo-mirror";
export { DETAIL_VIEW, SALE_LIST_COLUMNS };

const DISCOVERY_VIEW = DISCOVERY_VIEW_NAME as typeof DETAIL_VIEW;
const UNLOCKED_SALE_VIEW = UNLOCKED_VIEW as typeof DETAIL_VIEW;
const SEARCH_VIEW = "v_auction_sales_app_search" as typeof DETAIL_VIEW;
const DISCOVERY_SEARCH_VIEW = "v_auction_sales_discovery_search" as typeof DETAIL_VIEW;
const PUBLIC_PREVIEW_VIEW = "v_auction_sales_app_preview";

type SupabaseReader = Pick<SupabaseBrowserClient, "from">;

/**
 * Copies hébergées des photos : la fonction publique est lue avec le client navigateur, chargé à la
 * demande (voir `getSupabase`).
 */
async function mirrorClient(): Promise<PhotoMirrorClient> {
  return (await getSupabase()) as unknown as PhotoMirrorClient;
}
const mirrorOptions = { timeoutMs: PHOTO_MIRROR_BROWSER_TIMEOUT_MS, remember: true };

// Fields needed by the search result card only. Keep heavy descriptions,
// documents, source payloads and analysis evidence on the detail route.
const SALE_CARD_COLUMN_NAMES = [
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
  "completeness_tier",
] as const;

const SALE_CARD_COLUMNS = SALE_CARD_COLUMN_NAMES.join(",");

const SALE_PREVIEW_COLUMNS = [
  "id",
  "starting_price_eur",
  "sale_venue_type",
  "sale_verification_status",
].join(",");

function previewSortDirection(sort: SortKey): boolean {
  return sort === "price_desc" ? false : true;
}

type SortClause = { column: string; ascending: boolean };

/**
 * Colonnes de tri de chaque option, dans l'ordre de priorité. `coordinates_rank` (ventes
 * géolocalisées d'abord) passe toujours avant, et `id` départage toujours en dernier : sans
 * clé unique, une pagination par décalage peut sauter ou répéter des ventes.
 * Les valeurs vides vont toujours en fin de liste.
 */
const SORT_CLAUSES: Record<SortKey, SortClause[]> = {
  // Tri par défaut : palier de complétude (annonces bien renseignées d'abord), puis date de vente
  // la plus proche. Voir `src/lib/listing-completeness-ranking.ts`.
  completeness_desc: [
    { column: "completeness_tier", ascending: false },
    { column: "sale_date", ascending: true },
  ],
  date_asc: [{ column: "sale_date", ascending: true }],
  date_desc: [{ column: "sale_date", ascending: false }],
  price_asc: [{ column: "starting_price_eur", ascending: true }],
  price_desc: [{ column: "starting_price_eur", ascending: false }],
  // Tri explicite réservé à l'offre Analyse (le score n'existe pas dans les autres vues).
  score_desc: [{ column: "investment_score", ascending: false }],
  surface_desc: [{ column: "app_surface_m2", ascending: false }],
  beds_desc: [{ column: "bedrooms_count", ascending: false }],
};

type OrderableQuery<TQuery> = {
  order: (column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) => TQuery;
};

/** Applique le tri complet d'une recherche sur une vue `_search` (voir `SORT_CLAUSES`). */
function applySearchOrder<TQuery extends OrderableQuery<TQuery>>(
  query: TQuery,
  sort: SortKey,
): TQuery {
  let ordered = query.order("coordinates_rank", { ascending: true });
  for (const clause of SORT_CLAUSES[sort]) {
    ordered = ordered.order(clause.column, { ascending: clause.ascending, nullsFirst: false });
  }
  return ordered.order("id", { ascending: true });
}

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

// Les requêtes PostgREST sont construites avec des listes de colonnes et des vues dynamiques :
// le client ne peut pas en déduire le type des lignes, ni de la requête. On les manipule donc
// via la surface minimale de filtrage ci-dessus.
function applySaleTypeFilter<TQuery>(query: TQuery, filters: SaleFilters): TQuery {
  let q = query as FilterableQuery;
  if (filters.sale_venue_type === "unknown") {
    q = q.in("sale_venue_type", ["unknown", "online"]);
  } else if (filters.sale_venue_type) {
    q = q.eq("sale_venue_type", filters.sale_venue_type);
  }
  return q as TQuery;
}

function applyAuthenticatedSaleFilters<TQuery>(query: TQuery, filters: SaleFilters) {
  let q = applySaleTypeFilter(query, filters) as FilterableQuery;

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
    // Les codes de la classe du filtre (`matchesOccupancyFilter`), avant le décompte et la pagination.
    const occupancy = occupancyClass(filters.occupancy_status);
    q = q.in("occupancy_status", occupancy ? occupancyClassCodes(occupancy) : []);
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
  if (filters.updated_since) q = q.gte("updated_at", filters.updated_since);
  if (filters.ids?.length) q = q.in("id", filters.ids);
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

  return q as TQuery;
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
        return saleRows(data);
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
  let q = applySearchOrder(db.from(catalogView).select("id"), sort).range(
    offset,
    offset + limit - 1,
  );
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
  options: {
    preview?: boolean;
    discovery?: boolean;
    client?: SupabaseReader;
  } = {},
): Promise<AuctionSale[]> {
  if (!options.client && !assertCloudConfigured()) return [];
  const db = options.client ?? (await getSupabase());

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
    if (error) throw error;
    return saleRows(data);
  }

  const catalogView = options.discovery ? DISCOVERY_SEARCH_VIEW : SEARCH_VIEW;
  let q = applySearchOrder(db.from(catalogView).select(SALE_LIST_COLUMNS), sort).range(
    offset,
    offset + limit - 1,
  );

  q = applyAuthenticatedSaleFilters(q, filters);

  const { data, error } = await q;
  if (error) throw error;
  return saleRows(data);
}

/**
 * Ventes à évaluer par les alertes : mêmes filtres et même ordre que `getSales` (date croissante),
 * mais sans les colonnes lourdes de la vue (`ALERT_EVALUATION_COLUMNS`). Les blocs des sources et
 * les pièces des ventes retenues se relisent avec `getSaleAlertDetails`.
 */
export async function getSalesForAlertEvaluation(
  filters: SaleFilters,
  limit: number,
  offset: number,
  options: { client: SupabaseReader; discovery?: boolean },
): Promise<AuctionSale[]> {
  const catalogView = options.discovery ? DISCOVERY_SEARCH_VIEW : SEARCH_VIEW;
  let q = applySearchOrder(
    options.client.from(catalogView).select(ALERT_EVALUATION_COLUMNS),
    "date_asc",
  ).range(offset, offset + limit - 1);
  q = applyAuthenticatedSaleFilters(q, filters);

  const { data, error } = await q;
  if (error) throw error;
  return saleRows(data);
}

/** Blocs des sources et pièces de ces ventes (catalogue Analyse), par lots de 100 identifiants. */
export async function getSaleAlertDetails(
  ids: string[],
  options: { client: SupabaseReader },
): Promise<AuctionSale[]> {
  if (!ids.length) return [];
  return fetchSaleRowsByIds(options.client, SEARCH_VIEW, ALERT_DETAIL_COLUMNS, {}, ids);
}

/**
 * Une page du balayage complet des filtres avancés de `/sales` : mêmes filtres et même tri que la
 * recherche, mais seulement les colonnes légères que ces filtres lisent (`SEARCH_SCAN_COLUMNS`). Les
 * colonnes lourdes se relisent ensuite par identifiants, pour peu de ventes (`getSaleRowsByIds`).
 */
export async function getSalesForCompleteSearch(
  filters: SaleFilters,
  limit: number,
  sort: SortKey,
  offset: number,
  options: { discovery?: boolean; client?: SupabaseReader } = {},
): Promise<AuctionSale[]> {
  if (!options.client && !assertCloudConfigured()) return [];
  const db = options.client ?? (await getSupabase());
  const catalogView = options.discovery ? DISCOVERY_SEARCH_VIEW : SEARCH_VIEW;
  let q = applySearchOrder(db.from(catalogView).select(SEARCH_SCAN_COLUMNS), sort).range(
    offset,
    offset + limit - 1,
  );
  q = applyAuthenticatedSaleFilters(q, filters);
  const { data, error } = await q;
  if (error) throw error;
  return saleRows(data);
}

/**
 * Colonnes complémentaires de ventes déjà retenues, lues par lots de 100 identifiants dans la vue de
 * recherche du compte : `card` pour la carte de résultat (photos, pastilles), `detail` pour les filtres
 * qui lisent les blocs des sources, les pièces ou les descriptions. L'ordre rendu n'est pas garanti.
 */
export async function getSaleRowsByIds(
  ids: string[],
  columns: "card" | "detail",
  options: { discovery?: boolean; client?: SupabaseReader } = {},
): Promise<AuctionSale[]> {
  if (!ids.length) return [];
  if (!options.client && !assertCloudConfigured()) return [];
  const db = options.client ?? (await getSupabase());
  const catalogView = options.discovery ? DISCOVERY_SEARCH_VIEW : SEARCH_VIEW;
  if (columns === "detail") {
    return fetchSaleRowsByIds(db, catalogView, SEARCH_DETAIL_COLUMNS, {}, ids);
  }
  return fetchSaleRowsByIds(db, catalogView, SALE_CARD_COLUMNS, {}, ids);
}

export async function getSalesForSearch(
  filters: SaleFilters = {},
  limit = 100,
  sort: SortKey = "date_asc",
  offset = 0,
  options: { discovery?: boolean; client?: SupabaseReader } = {},
): Promise<AuctionSale[]> {
  if (!options.client && !assertCloudConfigured()) return [];

  const db = options.client ?? (await getSupabase());
  const catalogView = options.discovery ? DISCOVERY_SEARCH_VIEW : SEARCH_VIEW;

  // The discovery view is a security barrier. EXPLAIN shows that selecting
  // IDs and then re-reading the barrier doubles its materialization cost, so
  // keep its existing single request. The app search view is invoker-safe and
  // can prune the heavy lateral projections when the first request selects
  // only IDs.
  if (!options.discovery) {
    const ids = await fetchSearchResultIds(db, catalogView, filters, limit, sort, offset);
    if (ids.length === 0) return [];
    // Les identifiants lus sont déjà dans la liste `filters.ids` : on ne la renvoie pas une seconde fois
    // dans l'URL (jusqu'à 100 identifiants pour « Pépites seulement »).
    const rows = await fetchSaleRowsByIds(
      db,
      catalogView,
      SALE_CARD_COLUMNS,
      { ...filters, ids: undefined },
      ids,
    );
    return orderSalesByIds(rows, ids);
  }

  let q = applySearchOrder(db.from(catalogView).select(SALE_CARD_COLUMNS), sort).range(
    offset,
    offset + limit - 1,
  );

  q = applyAuthenticatedSaleFilters(q, filters);

  const { data, error } = await q;
  if (error) throw error;
  return saleRows(data);
}

export async function getSalesCount(
  filters: SaleFilters = {},
  options: { discovery?: boolean } = {},
): Promise<number> {
  if (!assertCloudConfigured()) return 0;
  const catalogView = options.discovery ? DISCOVERY_VIEW : DETAIL_VIEW;
  const supabase = await getSupabase();
  let q = supabase.from(catalogView).select("id", { count: "exact", head: true });

  q = applyAuthenticatedSaleFilters(q, filters);

  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

export async function getSaleById(
  id: string,
  options: { discovery?: boolean; unlocked?: boolean } = {},
): Promise<AuctionSale | null> {
  if (!assertCloudConfigured()) return null;
  if (typeof window === "undefined") return null;
  const supabase = await getSupabase();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;
  // A sale the account unlocked is read through its own redacted view, never through the full one.
  const catalogView = options.unlocked
    ? UNLOCKED_SALE_VIEW
    : options.discovery
      ? DISCOVERY_VIEW
      : DETAIL_VIEW;
  const { data, error } = await supabase.from(catalogView).select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data
    ? withPhotoMirror(
        sanitizeAuctionSaleForDisplay(data as AuctionSale),
        await mirrorClient(),
        mirrorOptions,
      )
    : null;
}

export async function getSalePreviewById(id: string): Promise<AuctionSale | null> {
  if (!assertCloudConfigured()) return null;
  // Card-level facts of the public catalogue (type, surface, city, hearing date…).
  const supabase = await getSupabase();
  const summary = await fetchPublicSaleSummary(supabase, id);
  if (summary.kind === "missing") return null;
  return withPhotoMirror(summary.sale, await mirrorClient(), mirrorOptions);
}

/** Colonnes minimales d'un point de carte : identifiant, position et de quoi étiqueter la pastille. */
const SALE_MAP_POINT_COLUMNS = [
  "id",
  "latitude",
  "longitude",
  "starting_price_eur",
  "city",
  "department",
  "property_type",
  "sale_date",
  "sale_venue_type",
  "sale_verification_status",
  // Précision et signalements de position : un centre de commune ou un point douteux se dessine
  // en pointillé (voir `isApproximatePosition`). Exposés par les vues de la fiche et « découverte ».
  "location_precision",
  "quality_flags",
].join(",");
const MAP_POINT_PAGE_SIZE = 1000;
/** Garde-fou : le catalogue entier (quelques milliers de ventes) tient largement dessous. */
const MAP_POINTS_HARD_LIMIT = 10_000;

/**
 * Tous les points géolocalisés d'une recherche (et non un échantillon), en colonnes
 * minimales, par pages de 1 000 lignes triées par identifiant pour une pagination stable.
 */
export async function getSaleMapPoints(
  filters: SaleFilters = {},
  options: { discovery?: boolean; client?: SupabaseReader } = {},
): Promise<AuctionSale[]> {
  if (!options.client && !assertCloudConfigured()) return [];
  const db = options.client ?? (await getSupabase());
  const catalogView = options.discovery ? DISCOVERY_VIEW : DETAIL_VIEW;
  // The pages are read in parallel once the total is known (see `readPagedRows`): same points,
  // same order (by identifier), same limit as reading them one after the other.
  const { rows } = await readPagedRows<AuctionSale>({
    pageSize: MAP_POINT_PAGE_SIZE,
    maxRows: MAP_POINTS_HARD_LIMIT,
    countTotal: async () => {
      let q = db
        .from(catalogView)
        .select("id", { count: "exact", head: true })
        .not("latitude", "is", null)
        .not("longitude", "is", null);
      q = applyAuthenticatedSaleFilters(q, filters);
      const { count, error } = await q;
      if (error) throw error;
      return count;
    },
    readPage: async (from) => {
      let q = db
        .from(catalogView)
        .select(SALE_MAP_POINT_COLUMNS)
        .not("latitude", "is", null)
        .not("longitude", "is", null)
        .order("id", { ascending: true })
        .range(from, from + MAP_POINT_PAGE_SIZE - 1);
      q = applyAuthenticatedSaleFilters(q, filters);
      const { data, error } = await q;
      if (error) throw error;
      return saleRows(data);
    },
  });
  return rows;
}
