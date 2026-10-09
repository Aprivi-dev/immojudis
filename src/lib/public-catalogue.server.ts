import { unstable_cache } from "next/cache";
import { excludeHomepageExampleSales } from "@/lib/example-sale-identity";
import {
  runPreviewSearch,
  type PreviewRpcClient,
  type PreviewSearchResponse,
} from "@/lib/search/preview-search";
import { salesSearchSignature, type SalesSearchParams } from "@/lib/search/search-url-state";
import { createPublicSupabaseClient } from "@/lib/supabase-public.server";
import type { AuctionSale } from "@/lib/types";

/** First page of the catalogue as seen by a signed-out visitor. */
export type InitialCatalogue = {
  signature: string;
  items: AuctionSale[];
  count: number;
};

/** The unfiltered first page is shared by every visitor and cached for 5 minutes. */
export const FIRST_PAGE_REVALIDATE_SECONDS = 300;
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
};

function defaultSearch(search: SalesSearchParams): Promise<PreviewSearchResponse> {
  const client = createPublicSupabaseClient();
  if (!client) return Promise.reject(new Error("Supabase n'est pas configuré côté serveur."));
  return runPreviewSearch(client as unknown as PreviewRpcClient, search);
}

// Next 16 without Cache Components: the data cache is `unstable_cache`
// (`use cache` requires the app-wide `cacheComponents` flag, which is
// incompatible with the route segment configs used elsewhere in this app).
const cachedFirstPage = unstable_cache(
  () => defaultSearch({}),
  ["public-catalogue", "first-page", "v1"],
  {
    revalidate: FIRST_PAGE_REVALIDATE_SECONDS,
    tags: [PUBLIC_CATALOGUE_CACHE_TAG],
  },
);

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
    return {
      signature: salesSearchSignature(search),
      items: excludeHomepageExampleSales(response.items),
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
