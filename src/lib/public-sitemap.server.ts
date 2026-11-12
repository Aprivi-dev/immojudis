import { unstable_cache } from "next/cache";
import { createPublicSupabaseClient } from "@/lib/supabase-public.server";
import { publicSupabaseConfigurationError } from "@/lib/supabase-configuration-error";

/**
 * Publicly visible and indexable sales for the sitemap, read with the anonymous client through
 * the same visibility rules as the public catalogue (and the indexability predicate of
 * `app_private.is_indexable_public_sale`, applied by the database function).
 *
 * A sitemap file holds at most 50 000 URLs; we stay at 5 000 so each file is quick to build and
 * to fetch. The sales have their own sitemap files, `/sales/sitemap/0.xml`, `1.xml`…, of
 * SITEMAP_URL_LIMIT sales each; the static pages (`/sitemap.xml`) and the articles
 * (`/ressources/sitemap.xml`) are listed apart.
 */
export const SITEMAP_URL_LIMIT = 5_000;
const SITEMAP_REVALIDATE_SECONDS = 3_600;
export const SITEMAP_CACHE_TAG = "public-sitemap";
/** PostgREST returns at most 1 000 rows per request. */
const DATABASE_PAGE_SIZE = 1_000;

/**
 * `lastModified` : date du dernier changement VISIBLE de la fiche (`content_changed_at`), jamais la
 * date technique de la ligne (`updated_at` bouge à chaque passage de la collecte). `null` tant que la
 * fiche n'a pas changé depuis la pose de la colonne : le sitemap n'émet alors aucun `lastmod`.
 */
export type SitemapSale = { id: string; lastModified: string | null };
export type SitemapSalePage = { sales: SitemapSale[]; total: number };

type SitemapClient = {
  rpc: (
    fn: "list_public_sale_sitemap_entries",
    args: { p_limit: number; p_offset: number },
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

/**
 * One page of publicly visible sales, ordered by id, through the dedicated RPC (identifier + date
 * of the last visible change). A row without `content_changed_at` emits no date, never the
 * technical `updated_at`.
 */
export async function fetchSitemapSalePage(
  client: SitemapClient,
  pageIndex: number,
): Promise<SitemapSalePage> {
  const offset = pageIndex * DATABASE_PAGE_SIZE;
  const { data, error } = await client.rpc("list_public_sale_sitemap_entries", {
    p_limit: DATABASE_PAGE_SIZE,
    p_offset: offset,
  });
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: string;
    content_changed_at?: string | null;
    total_count: number | string;
  }>;
  return {
    sales: rows.map((row) => ({ id: row.id, lastModified: row.content_changed_at ?? null })),
    total: rows.length > 0 ? Number(rows[0].total_count) : offset,
  };
}

const cachedSalePage = unstable_cache(
  async (pageIndex: number): Promise<SitemapSalePage> => {
    const client = createPublicSupabaseClient();
    if (!client) throw publicSupabaseConfigurationError();
    return fetchSitemapSalePage(client as unknown as SitemapClient, pageIndex);
  },
  ["public-sitemap", "sales-page", "v2"],
  { revalidate: SITEMAP_REVALIDATE_SECONDS, tags: [SITEMAP_CACHE_TAG] },
);

export type SalePageLoader = (pageIndex: number) => Promise<SitemapSalePage>;

/** Total number of publicly visible sales. */
export async function loadSitemapSaleTotal(
  loadPage: SalePageLoader = cachedSalePage,
): Promise<number> {
  return (await loadPage(0)).total;
}

/** Sales with position in [start, end) in the stable (id) ordering. */
export async function loadSitemapSales(
  start: number,
  end: number,
  loadPage: SalePageLoader = cachedSalePage,
): Promise<SitemapSale[]> {
  if (end <= start) return [];
  const first = Math.floor(start / DATABASE_PAGE_SIZE);
  const last = Math.floor((end - 1) / DATABASE_PAGE_SIZE);
  const sales: SitemapSale[] = [];
  for (let pageIndex = first; pageIndex <= last; pageIndex += 1) {
    const page = await loadPage(pageIndex);
    sales.push(...page.sales);
    if (page.sales.length < DATABASE_PAGE_SIZE) break;
  }
  const offset = first * DATABASE_PAGE_SIZE;
  return sales.slice(start - offset, end - offset);
}

/** Number of sales sitemap files (`/sales/sitemap/N.xml`) needed for `total` sales. */
export function salesSitemapCount(total: number): number {
  return total > 0 ? Math.ceil(total / SITEMAP_URL_LIMIT) : 0;
}
