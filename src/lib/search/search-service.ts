import { getSales, getSalesCount, getSalesForSearch, getSaleMapPoints } from "@/lib/queries";
import { getSupabase } from "@/integrations/supabase/lazy";
import { readJson } from "@/lib/client-api-core";
import { geocodeAddress } from "@/lib/geo";
import { readPagedRows } from "@/lib/paged-read";
import {
  PHOTO_MIRROR_BROWSER_TIMEOUT_MS,
  applyPhotoMirrors,
  fetchPhotoMirrors,
  isPhotoMirrorEnabled,
  withPhotoMirrors,
  type PhotoMirrorClient,
} from "@/lib/photo-mirror";
import type { AuctionSale, SaleMediaMirror } from "@/lib/types";
import { excludeHomepageExampleSales } from "@/lib/example-sale-identity";
import { previewSearchRequestKey, type PreviewSearchResponse } from "./preview-search";
import { previewSearchApiUrl, type PreviewSearchApiResponse } from "./preview-search-request";
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

/** Garde-fou de la lecture complète des filtres avancés : au-delà, la recherche est trop large. */
const MAX_COMPLETE_SEARCH_ROWS = 10_000;

/** Réponse de la route d'aperçu : les ventes, leur total et les copies de photos trouvées. */
type PreviewSearchPage = PreviewSearchResponse & {
  mirrors: ReadonlyMap<string, SaleMediaMirror>;
};

const inFlightPreviewSearches = new Map<string, Promise<PreviewSearchPage>>();

/**
 * Page de résultats avec, quand l'interrupteur est ouvert, la copie hébergée de la photo
 * principale de chaque vente. Aperçu anonyme : un seul appel à notre route `/api/catalogue/preview`,
 * qui renvoie les ventes et les copies ensemble. Recherche connectée : les copies sont lues en un
 * appel après la lecture des ventes (aucune jointure dans les fonctions SQL de recherche, jamais
 * bloquant). La première page rendue par le serveur reçoit les mêmes copies
 * (`loadInitialCatalogue`), pour que les rafraîchissements ne changent pas les images.
 */
export async function fetchSearchResults(options: {
  search: SalesSearchParams;
  preview: boolean;
  discovery?: boolean;
  /**
   * `false` : la recherche connectée rend les ventes dès qu'elles sont lues, sans attendre les
   * copies de photos (`fetchSearchPhotoMirrors`, à poser ensuite avec `applyPhotoMirrors`). Sans
   * effet sur l'aperçu anonyme, dont la route apporte déjà les copies.
   */
  withMirrors?: boolean;
}): Promise<AuctionSale[]> {
  if (options.preview) {
    const page = await fetchPreviewSearch(options.search);
    return applyPhotoMirrors(page.items, page.mirrors, { remember: true });
  }
  const sales = await loadSearchResults(options);
  if (options.withMirrors === false) return sales;
  // Le client Supabase n'est chargé que si les copies sont demandées (voir `lazy.ts`).
  if (!sales.length || !isPhotoMirrorEnabled()) return sales;
  return withPhotoMirrors(sales, (await getSupabase()) as unknown as PhotoMirrorClient, {
    timeoutMs: PHOTO_MIRROR_BROWSER_TIMEOUT_MS,
    remember: true,
  });
}

/**
 * Copies de photos des ventes d'une page connectée, lues en un appel (URL d'origine vers copie).
 * Jamais bloquant : interrupteur éteint, panne ou délai dépassé donnent une table vide.
 */
export async function fetchSearchPhotoMirrors(
  sales: AuctionSale[],
): Promise<ReadonlyMap<string, SaleMediaMirror>> {
  if (!sales.length || !isPhotoMirrorEnabled()) return new Map();
  const client = (await getSupabase()) as unknown as PhotoMirrorClient;
  let found: ReadonlyMap<string, SaleMediaMirror> = new Map();
  // `withPhotoMirrors` choisit les photos que l'écran montre ; on n'en garde que les copies.
  await withPhotoMirrors(sales, client, {
    fetchMirrors: async (urls) => {
      const mirrors = await fetchPhotoMirrors(client, urls, {
        timeoutMs: PHOTO_MIRROR_BROWSER_TIMEOUT_MS,
      });
      found = mirrors;
      return mirrors;
    },
  });
  return found;
}

async function loadSearchResults({
  search,
  discovery = false,
}: {
  search: SalesSearchParams;
  discovery?: boolean;
}): Promise<AuctionSale[]> {
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
      dataSortFromSearch(search.sort, { allowInvestmentScore: !discovery }),
      offset,
      { discovery },
    ),
  );
}

// The total is deliberately NOT folded into the list request (`count` on the
// page query). The list reads the invoker-safe search view (ids first, then the
// card rows) while this exact count reads the detail/discovery view, so a count
// taken from the list query could differ from today's total. Switching to
// `count: "estimated"` would also turn an exact figure into an approximation.
// The preview path already gets its count from the same RPC call as its rows,
// and client-only filters share one cached scan between list, count and map.
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

/**
 * Recherche d'aperçu : un seul GET sur notre domaine, sans Supabase ni vérification CORS. La liste
 * et le total d'une même recherche partagent cet appel (clé identique, dédoublonnée en vol).
 */
function fetchPreviewSearch(search: SalesSearchParams): Promise<PreviewSearchPage> {
  const requestKey = previewSearchRequestKey(search);
  const currentRequest = inFlightPreviewSearches.get(requestKey);
  if (currentRequest) return currentRequest;

  const request = requestPreviewSearch(search).finally(() =>
    inFlightPreviewSearches.delete(requestKey),
  );

  inFlightPreviewSearches.set(requestKey, request);
  return request;
}

async function requestPreviewSearch(search: SalesSearchParams): Promise<PreviewSearchPage> {
  const response = await fetch(previewSearchApiUrl(search), {
    headers: { accept: "application/json" },
  });
  const body = await readJson<PreviewSearchApiResponse | null>(response);
  // Une réponse 200 qui n'est pas du JSON (page d'erreur d'un proxy, corps vide) donne `null` : on
  // la refuse ici plutôt que de laisser le rendu lire `undefined.length`.
  if (
    !Array.isArray(body?.items) ||
    typeof body.count !== "number" ||
    !Number.isFinite(body.count)
  ) {
    throw new Error("Le catalogue a renvoyé une réponse illisible. Réessayez dans un instant.");
  }
  // Les copies ne bloquent jamais l'affichage : une table absente ou illisible vaut « aucune copie ».
  return {
    items: body.items,
    count: body.count,
    mirrors: new Map(Array.isArray(body.mirrors) ? body.mirrors : []),
  };
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
    const batchSize = 100;
    const dataFilters = dataFiltersFromSearch(criteria);
    const dataSort = dataSortFromSearch(search.sort, { allowInvestmentScore: !discovery });
    // The batches are read in parallel once the total is known (see `readPagedRows`): same rows,
    // same order, same limit as reading them one after the other.
    const { rows, truncated } = await readPagedRows<AuctionSale>({
      pageSize: batchSize,
      maxRows: MAX_COMPLETE_SEARCH_ROWS,
      countTotal: () => getSalesCount(dataFilters, { discovery }),
      // Advanced client-side filters need fields intentionally omitted from
      // the lightweight card projection (DPE, visits, documents, evidence).
      readPage: (offset) =>
        getSales(dataFilters, batchSize, dataSort, offset, { discovery, completenessTier: true }),
    });
    if (truncated)
      throw new Error(
        "Cette recherche est trop large. Choisissez une région ou un département pour appliquer les filtres avancés.",
      );
    return sortClientSearchResults(
      applyClientSearchFilters(excludeHomepageExampleSales(rows), search, center),
      search,
      center,
    );
  })().finally(() => completeSearches.delete(key));
  completeSearches.set(key, request);
  return request;
}
