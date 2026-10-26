import type { Database } from "@/integrations/supabase/types";
import { PublicApiError } from "@/lib/api-errors";
import { listPepiteSaleIds } from "@/lib/pepite-sale-ids";
import { isLikelyPropertyImageUrl } from "@/lib/sale-media";
import type { AuctionSale, SortKey } from "@/lib/types";
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
    fn:
      | "search_auction_sales_preview_v3"
      | "search_auction_sales_preview_v4"
      | "list_public_pepite_sale_ids",
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
    // La RPC publique ne sait pas trier par chambres : repli explicite sur la pertinence (le tri
    // n'est d'ailleurs pas proposé en aperçu).
    p_sort: previewSort(dataSortFromSearch(search.sort)),
    p_limit: perPage,
    p_offset: (page - 1) * perPage,
  };
}

function previewSort(sort: SortKey): SortKey {
  return sort === "beds_desc" ? "completeness_desc" : sort;
}

export function previewSearchRequestKey(search: SalesSearchParams): string {
  return JSON.stringify([
    buildPreviewSearchArgs(search),
    search.minSaleDate,
    search.maxSaleDate,
    // Mêmes arguments de lecture, autre résultat : la liste des pépites est croisée après la lecture.
    search.pepite === true,
  ]);
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
    completeness_tier: row.completeness_tier,
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

/**
 * Erreur lisible pour le journal. PostgREST renvoie un objet simple (`message`, `code`, `details`,
 * `hint`), pas une `Error` : levé tel quel, il s'imprime « [object Object] » ou sans pile. Le
 * message dit quelle recherche a échoué, avec le message et le code de la base ; l'objet d'origine
 * reste dans `cause`. La route répond de toute façon par un message générique (jamais ce texte).
 */
function previewSearchError(error: unknown): Error {
  if (error instanceof Error) return error;
  const { message, code } =
    typeof error === "object" && error !== null
      ? (error as { message?: unknown; code?: unknown })
      : ({} as { message?: unknown; code?: unknown });
  const detail = typeof message === "string" && message ? message : "erreur inconnue";
  const suffix = typeof code === "string" && code ? ` (code ${code})` : "";
  return new Error(`Recherche d'aperçu en échec : ${detail}${suffix}`, { cause: error });
}

async function readPreviewRows(
  client: PreviewRpcClient,
  search: SalesSearchParams,
): Promise<PreviewSearchRow[]> {
  const args = buildPreviewSearchArgs(search);
  const { data, error } = await (search.minSaleDate || search.maxSaleDate
    ? client.rpc("search_auction_sales_preview_v4", {
        ...args,
        p_min_sale_date: search.minSaleDate ?? null,
        p_max_sale_date: search.maxSaleDate ?? null,
      })
    : client.rpc("search_auction_sales_preview_v3", args));
  if (error) throw previewSearchError(error);
  return (data ?? []) as PreviewSearchRow[];
}

/**
 * Lignes lues au plus pour un filtre « Pépites seulement » : au-delà (trois fois le catalogue actuel), la recherche
 * est refusée comme celle des filtres avancés d'un compte (« trop large »), jamais tronquée en silence.
 */
export const MAX_PEPITE_SCAN_ROWS = 3_000;
const PEPITE_SCAN_PAGE_SIZE = 100;
/** Pages lues en parallèle au plus : la base ne reçoit jamais une rafale de quinze appels. */
export const PEPITE_SCAN_CONCURRENCY = 4;
export const PEPITE_SCAN_TOO_WIDE_MESSAGE =
  "Cette recherche est trop large. Choisissez une région ou un département pour appliquer les filtres avancés.";

/**
 * « Pépites seulement » pour un visiteur, première étape : la liste publique des identifiants (un appel) croisée
 * avec TOUTES les lignes de la recherche, lues par pages de 100 dans leur ordre (mêmes lignes et même ordre que
 * sans le filtre), 4 pages à la fois au plus. Le résultat (sans pagination) est celui que le serveur garde en cache
 * (`public-catalogue.server.ts`). Sans pépite (mode pas « on », fonction absente, erreur de lecture de la liste) :
 * aucune ligne et aucune lecture du catalogue, jamais « toutes les ventes » à la place de la liste. Plus de
 * `MAX_PEPITE_SCAN_ROWS` lignes : erreur « recherche trop large ».
 */
export async function readPepiteScan(
  client: PreviewRpcClient,
  search: SalesSearchParams,
): Promise<PreviewSearchRow[]> {
  const pepiteIds = new Set(
    await listPepiteSaleIds({ rpc: (fn) => client.rpc(fn, {}) }).catch((): string[] => []),
  );
  if (pepiteIds.size === 0) return [];
  const scan = { ...search, pepite: undefined, page: 1, limit: PEPITE_SCAN_PAGE_SIZE };
  const first = await readPreviewRows(client, scan);
  const total = Number(first[0]?.total_count ?? 0);
  if (total > MAX_PEPITE_SCAN_ROWS) throw new PublicApiError(PEPITE_SCAN_TOO_WIDE_MESSAGE, 400);
  const pages = Math.ceil(total / PEPITE_SCAN_PAGE_SIZE);
  const rows: PreviewSearchRow[][] = [first];
  let next = 2;
  const worker = async () => {
    while (next <= pages) {
      const page = next;
      next += 1;
      rows[page - 1] = await readPreviewRows(client, { ...scan, page });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PEPITE_SCAN_CONCURRENCY, pages - 1) }, worker));
  return rows.flat().filter((row) => pepiteIds.has(String(row.id).toLowerCase()));
}

/** Seconde étape : la page demandée du résultat filtré. */
export function pepitePage(
  rows: readonly PreviewSearchRow[],
  search: SalesSearchParams,
): PreviewSearchResponse {
  const perPage = search.limit ?? DEFAULT_SEARCH_LIMIT;
  const offset = ((search.page ?? 1) - 1) * perPage;
  return { items: mapPreviewRows(rows.slice(offset, offset + perPage)), count: rows.length };
}

export async function runPreviewSearch(
  client: PreviewRpcClient,
  search: SalesSearchParams,
): Promise<PreviewSearchResponse> {
  if (search.pepite) return pepitePage(await readPepiteScan(client, search), search);
  const rows = await readPreviewRows(client, search);
  return {
    items: mapPreviewRows(rows),
    count: Number(rows[0]?.total_count ?? 0),
  };
}
