import {
  getSaleMapPoints,
  getSaleRowsByIds,
  getSalesCount,
  getSalesForCompleteSearch,
  getSalesForSearch,
} from "@/lib/queries";
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
import type { AuctionSale, SaleFilters, SaleMediaMirror } from "@/lib/types";
import { excludeHomepageExampleSales } from "@/lib/example-sale-identity";
import { previewSearchRequestKey, type PreviewSearchResponse } from "./preview-search";
import {
  previewSearchApiUrl,
  previewSearchPageOutOfRange,
  type PreviewSearchApiResponse,
} from "./preview-search-request";
import { fetchUnderRangeSaleIds } from "./market-range-filter";
import { fetchPepiteSaleIds } from "./pepite-filter";
import { SearchRejectedError } from "./search-errors";
import { resolveFrenchGeoSearch } from "./french-geo-search";
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

/**
 * Au plus autant d'identifiants passés à la base dans une même lecture : ils voyagent dans l'adresse de
 * la requête (voir `SaleFilters.ids`). Au-delà, la liste est croisée avec les lignes lues.
 */
const MAX_ID_SCOPE = 100;

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
  const plan = await searchPlan(search);
  if (plan.kind === "none") return [];
  const page = search.page ?? 1;
  const perPage = search.limit ?? DEFAULT_SEARCH_LIMIT;
  const offset = (page - 1) * perPage;
  if (plan.kind === "scan") {
    const rows = await fetchCompleteFilteredSearch(search, discovery);
    // Le balayage ne lit que les colonnes légères : photos et pastilles de la carte de résultat sont
    // relues pour la seule page affichée.
    return withCardColumns(rows.slice(offset, offset + perPage), discovery);
  }
  return excludeHomepageExampleSales(
    await getSalesForSearch(
      plan.filters,
      perPage,
      dataSortFromSearch(search.sort, { allowInvestmentScore: !discovery }),
      offset,
      { discovery },
    ),
  );
}

type SearchPlan =
  /** Aucune vente possible (aucune pépite) : rien à lire. */
  | { kind: "none" }
  /** Tous les critères sont des filtres de la base : pagination, total et carte par la base. */
  | { kind: "server"; filters: SaleFilters }
  /** Un critère se lit sur les lignes : balayage complet partagé (`fetchCompleteFilteredSearch`). */
  | { kind: "scan" };

/**
 * Comment servir une recherche. « Pépites seulement » n'impose plus de balayer tout le catalogue : la
 * liste publique des pépites (quelques ventes, gardée 5 minutes) est passée à la base comme liste
 * d'identifiants, avec les autres filtres, le tri et la pagination. Le balayage ne reste que pour les
 * critères lus sur les lignes (prix au m², rendement, DPE…) ou une liste trop longue pour l'adresse.
 */
async function searchPlan(search: SalesSearchParams): Promise<SearchPlan> {
  if (hasClientOnlyFilters({ ...search, pepite: undefined })) return { kind: "scan" };
  const filters = dataFiltersFromSearch(search);
  if (!search.pepite) return { kind: "server", filters };
  const pepiteSaleIds = await fetchPepiteSaleIds();
  if (pepiteSaleIds.size === 0) return { kind: "none" };
  if (pepiteSaleIds.size > MAX_ID_SCOPE) return { kind: "scan" };
  return { kind: "server", filters: { ...filters, ids: [...pepiteSaleIds] } };
}

/** Ajoute aux lignes du balayage les colonnes de la carte de résultat (photos, pastilles), dans le même ordre. */
async function withCardColumns(rows: AuctionSale[], discovery: boolean): Promise<AuctionSale[]> {
  if (!rows.length) return rows;
  const cards = await getSaleRowsByIds(
    rows.map((row) => row.id),
    "card",
    { discovery },
  );
  return mergeRows(rows, cards);
}

function mergeRows(rows: AuctionSale[], extra: AuctionSale[]): AuctionSale[] {
  const extraById = new Map(extra.map((row) => [row.id, row]));
  return rows.map((row) => {
    const more = extraById.get(row.id);
    return more ? { ...row, ...more } : row;
  });
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

  const plan = await searchPlan(search);
  if (plan.kind === "none") return 0;
  if (plan.kind === "scan") return (await fetchCompleteFilteredSearch(search, discovery)).length;
  return getSalesCount(plan.filters, { discovery });
}

export async function fetchSearchMapResults(
  search: SalesSearchParams,
  options: { discovery?: boolean } = {},
): Promise<AuctionSale[]> {
  const plan = await searchPlan(search);
  if (plan.kind === "none") return [];
  if (plan.kind === "scan")
    return (await fetchCompleteFilteredSearch(search, options.discovery ?? false))
      .filter((sale) => sale.latitude != null && sale.longitude != null)
      .slice(0, MAX_MAP_RESULTS);
  // Tous les points de la recherche (identifiant, position, prix), pas un échantillon de 300.
  return excludeHomepageExampleSales(await getSaleMapPoints(plan.filters, options));
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
  // 400 : la route refuse la demande (page hors bornes, critère illisible). Ce n'est pas une panne.
  if (response.status === 400) {
    const refusal = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new SearchRejectedError(
      typeof refusal?.error === "string" ? refusal.error : "",
      previewSearchPageOutOfRange(search),
    );
  }
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
    // Ventes sous la fourchette : la liste vient de la base (elle calcule la bande vente par vente), et
    // une lecture impossible fait échouer la recherche au lieu d'afficher toutes les ventes.
    const underRangeSaleIds = search.belowRange ? await fetchUnderRangeSaleIds() : null;
    // Pépites : la liste publique des identifiants (une lecture, gardée 5 minutes). Vide quand le repère n'est
    // pas ouvert : le filtre ne passe alors aucune vente plutôt que toutes.
    const pepiteSaleIds = search.pepite ? await fetchPepiteSaleIds() : null;
    // Aucune pépite : rien à croiser, on ne lit pas le catalogue pour retirer toutes ses lignes.
    if (pepiteSaleIds && pepiteSaleIds.size === 0) return [];
    const batchSize = 100;
    // Les pépites réduisent la lecture elle-même quand leur liste tient dans l'adresse de la requête.
    const dataFilters: SaleFilters = {
      ...dataFiltersFromSearch(criteria),
      ids: pepiteSaleIds && pepiteSaleIds.size <= MAX_ID_SCOPE ? [...pepiteSaleIds] : undefined,
    };
    const dataSort = dataSortFromSearch(search.sort, { allowInvestmentScore: !discovery });
    // The batches are read in parallel once the total is known (see `readPagedRows`): same rows,
    // same order, same limit as reading them one after the other.
    const { rows, truncated } = await readPagedRows<AuctionSale>({
      pageSize: batchSize,
      maxRows: MAX_COMPLETE_SEARCH_ROWS,
      countTotal: () => getSalesCount(dataFilters, { discovery }),
      // Colonnes légères seulement (`SEARCH_SCAN_COLUMNS`) : les colonnes lourdes coûtaient plusieurs
      // secondes par page dans la base.
      readPage: (offset) =>
        getSalesForCompleteSearch(dataFilters, batchSize, dataSort, offset, { discovery }),
    });
    if (truncated)
      throw new Error(
        "Cette recherche est trop large. Choisissez une région ou un département pour appliquer les filtres avancés.",
      );
    const context = {
      underRangeSaleIds,
      pepiteSaleIds,
      // Comme sur les cartes : l'occupation ne compte parmi les points que si le compte la lit.
      occupancyVisible: !discovery,
    };
    let candidates = excludeHomepageExampleSales(rows);
    // DPE, visites ou texte : les autres critères trient d'abord sur les lignes légères, puis les blocs
    // des sources, les pièces et les descriptions ne sont relus que pour les ventes restantes.
    const light = withoutDetailCriteria(search);
    if (light) {
      candidates = applyClientSearchFilters(candidates, light, center, context);
      candidates = mergeRows(
        candidates,
        await getSaleRowsByIds(
          candidates.map((sale) => sale.id),
          "detail",
          { discovery },
        ),
      );
    }
    return sortClientSearchResults(
      applyClientSearchFilters(candidates, search, center, context),
      search,
      center,
    );
  })().finally(() => completeSearches.delete(key));
  completeSearches.set(key, request);
  return request;
}

/**
 * La recherche sans les critères qui lisent les colonnes lourdes (`SEARCH_DETAIL_COLUMNS` : DPE,
 * visites, texte, et les blocs des sources pour le rendement des ventes notariales et le type de vente),
 * pour un premier tri plus large ; `null` quand aucun de ces critères n'est actif.
 */
function withoutDetailCriteria(search: SalesSearchParams): SalesSearchParams | null {
  const textQuery = resolveFrenchGeoSearch(search.query).kind === "text";
  return search.dpeClasses?.length ||
    search.openHouse ||
    search.visitSoon ||
    search.keywords?.trim() ||
    search.minYield != null ||
    search.saleType ||
    textQuery
    ? {
        ...search,
        minYield: undefined,
        saleType: undefined,
        dpeClasses: undefined,
        openHouse: undefined,
        visitSoon: undefined,
        keywords: undefined,
        query: textQuery ? undefined : search.query,
      }
    : null;
}
