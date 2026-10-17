import { unstable_cache } from "next/cache";
import { excludeHomepageExampleSales } from "@/lib/example-sale-identity";
import {
  runPreviewSearch,
  type PreviewRpcClient,
  type PreviewSearchResponse,
} from "@/lib/search/preview-search";
import { isPhotoMirrorEnabled, withPhotoMirrors, type PhotoMirrorClient } from "@/lib/photo-mirror";
import { cachedPhotoMirrorFetcher } from "@/lib/photo-mirror.server";
import { salesSearchSignature, type SalesSearchParams } from "@/lib/search/search-url-state";
import { createPublicSupabaseClient } from "@/lib/supabase-public.server";
import type { AuctionSale, SaleMediaMirror } from "@/lib/types";

/** First page of the catalogue as seen by a signed-out visitor. */
export type InitialCatalogue = {
  signature: string;
  items: AuctionSale[];
  count: number;
};

/** The unfiltered first page is shared by every visitor and cached for 5 minutes. */
export const FIRST_PAGE_REVALIDATE_SECONDS = 300;
/**
 * Durée de garde (CDN) d'une recherche FILTRÉE de `/api/catalogue/preview`. Plus courte que celle de
 * la première page : une recherche étroite (ville, tribunal, prix, dates) est celle où l'on guette
 * une nouvelle annonce ou un changement de statut, alors que la première page, sans filtre, est lue
 * par tous les visiteurs et se rafraîchit en tâche de fond. Chaque adresse filtrée a de toute façon
 * peu de lecteurs : la garder moins longtemps coûte peu de lectures de la base, et le quota par IP
 * borne le reste.
 */
export const FILTERED_SEARCH_REVALIDATE_SECONDS = 120;
/**
 * Durée de garde d'une réponse dont les copies de photos ont échoué : le temps de laisser la base
 * respirer, sans que le CDN fige les photos des sources pour les 2 à 5 minutes habituelles.
 */
export const DEGRADED_MIRRORS_REVALIDATE_SECONDS = 10;
export const PUBLIC_CATALOGUE_CACHE_TAG = "public-catalogue";
/** Maximum time the server waits for the database before the browser takes over. */
const SERVER_SEARCH_TIMEOUT_MS = 6_000;
/** The public RPC refuses larger pages: such URLs are left to the browser path. */
const MAX_SERVER_PAGE_SIZE = 100;

const EMPTY_SIGNATURE = salesSearchSignature({});

export function isDefaultCatalogueSearch(search: SalesSearchParams): boolean {
  return salesSearchSignature(search) === EMPTY_SIGNATURE;
}

export type CatalogueDependencies = {
  /** Runs the public search; defaults to the anonymous server client. */
  search?: (search: SalesSearchParams) => Promise<PreviewSearchResponse>;
  /** Returns the shared, cached first page; defaults to Next's data cache. */
  firstPage?: () => Promise<PreviewSearchResponse>;
  timeoutMs?: number;
  /**
   * Client de la fonction `sale_photo_mirrors` ; par défaut le client anonyme du serveur. Utilisé
   * seulement si `NEXT_PUBLIC_PHOTO_MIRROR=on`.
   */
  photoMirrorClient?: PhotoMirrorClient | null;
};

function defaultSearch(search: SalesSearchParams): Promise<PreviewSearchResponse> {
  const client = createPublicSupabaseClient();
  if (!client) return Promise.reject(new Error("Supabase n'est pas configuré côté serveur."));
  return runPreviewSearch(client as unknown as PreviewRpcClient, search);
}

/**
 * Clé du cache de la première page. Elle change à chaque modification de l'ordre ou des champs
 * de cette page (v2 : tri par défaut par complétude, avec le palier de chaque annonce) : sinon
 * les visiteurs verraient l'ancien ordre jusqu'à cinq minutes après le déploiement.
 */
export const FIRST_PAGE_CACHE_KEY = ["public-catalogue", "first-page", "v2"] as const;

// Next 16 without Cache Components: the data cache is `unstable_cache`
// (`use cache` requires the app-wide `cacheComponents` flag, which is
// incompatible with the route segment configs used elsewhere in this app).
const cachedFirstPage = unstable_cache(() => defaultSearch({}), [...FIRST_PAGE_CACHE_KEY], {
  revalidate: FIRST_PAGE_REVALIDATE_SECONDS,
  tags: [PUBLIC_CATALOGUE_CACHE_TAG],
});

/** Le client n'est créé que si l'interrupteur est ouvert. */
function photoMirrorClient(): PhotoMirrorClient | null {
  if (!isPhotoMirrorEnabled()) return null;
  return createPublicSupabaseClient() as unknown as PhotoMirrorClient | null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Délai dépassé pour le catalogue public.")),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Loads the first screen of /sales on the server. Returns null when the
 * database is unavailable: the page then renders its server shell and the
 * browser fetches the results as before, so an outage never breaks the route.
 */
export async function loadInitialCatalogue(
  search: SalesSearchParams,
  dependencies: CatalogueDependencies = {},
): Promise<InitialCatalogue | null> {
  const run = dependencies.search ?? defaultSearch;
  const firstPage = dependencies.firstPage ?? cachedFirstPage;
  if (search.limit && search.limit > MAX_SERVER_PAGE_SIZE) return null;

  try {
    const response = await withTimeout(
      isDefaultCatalogueSearch(search) ? firstPage() : run(search),
      dependencies.timeoutMs ?? SERVER_SEARCH_TIMEOUT_MS,
    );
    // Copies hébergées des photos : un seul appel pour la page, après le cache de la première page.
    // Les copies trouvées ont leur propre cache de 5 minutes (photo-mirror.server.ts) ; une panne
    // ou un délai dépassé n'y est jamais gardé. Jamais bloquant : voir photo-mirror.ts.
    const mirrorClient =
      dependencies.photoMirrorClient !== undefined
        ? dependencies.photoMirrorClient
        : photoMirrorClient();
    const items = await withPhotoMirrors(
      excludeHomepageExampleSales(response.items),
      mirrorClient,
      {
        fetchMirrors: cachedPhotoMirrorFetcher(mirrorClient),
      },
    );
    return {
      signature: salesSearchSignature(search),
      items,
      count: response.count,
    };
  } catch (error) {
    console.warn(
      "[catalogue] Rendu serveur indisponible, repli sur le chargement navigateur:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/** Une page de la recherche d'aperçu pour le navigateur : ventes sans copie, total et copies. */
export type PreviewCataloguePage = {
  items: AuctionSale[];
  count: number;
  mirrors: Array<[string, SaleMediaMirror]>;
  /**
   * `true` si l'interrupteur des copies est ouvert, qu'au moins une photo a été cherchée et que la
   * lecture des copies a échoué ou dépassé son délai (table vide à cause d'elle). Une base qui
   * répond « aucune copie » n'est pas une dégradation. Ce drapeau n'est pas dans le corps de la
   * réponse : il sert à choisir la durée de cache.
   */
  mirrorsDegraded: boolean;
};

/**
 * Recherche d'aperçu servie par `GET /api/catalogue/preview` : la même fonction SQL, les mêmes
 * filtres et le même cache de la première page que le rendu serveur de `/sales`
 * (`loadInitialCatalogue`), puis les copies de photos de la page (même cache de 5 minutes), le tout
 * en une réponse. Contrairement au rendu serveur, une panne LÈVE : la route répond alors 503 et
 * rien n'est mis en cache. Une panne des seules copies ne lève pas : la liste est servie, marquée
 * `mirrorsDegraded`. Les ventes sont rendues sans copie ; les copies trouvées sont à part
 * (la route ne répond pas avec un état qui dépendrait du visiteur).
 */
export async function loadPreviewCataloguePage(
  search: SalesSearchParams,
  dependencies: CatalogueDependencies = {},
): Promise<PreviewCataloguePage> {
  const run = dependencies.search ?? defaultSearch;
  const firstPage = dependencies.firstPage ?? cachedFirstPage;
  const response = await withTimeout(
    isDefaultCatalogueSearch(search) ? firstPage() : run(search),
    dependencies.timeoutMs ?? SERVER_SEARCH_TIMEOUT_MS,
  );
  const items = excludeHomepageExampleSales(response.items);
  const mirrorClient =
    dependencies.photoMirrorClient !== undefined
      ? dependencies.photoMirrorClient
      : photoMirrorClient();
  let unavailable = false;
  const fetchMirrors = cachedPhotoMirrorFetcher(mirrorClient, {
    onUnavailable: () => {
      unavailable = true;
    },
  });
  let mirrors = new Map<string, SaleMediaMirror>();
  await withPhotoMirrors(items, mirrorClient, {
    fetchMirrors: async (urls) => {
      mirrors = await fetchMirrors(urls);
      return mirrors;
    },
  });
  return {
    items,
    count: response.count,
    mirrors: [...mirrors],
    mirrorsDegraded: unavailable && mirrors.size === 0,
  };
}
