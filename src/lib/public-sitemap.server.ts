import { unstable_cache } from "next/cache";
import { createPublicSupabaseClient } from "@/lib/supabase-public.server";

/**
 * Publicly visible sales for the sitemap, read with the anonymous client through
 * the same visibility rules as the public catalogue.
 *
 * A sitemap file holds at most 50 000 URLs; we stay at 5 000 so each file is
 * quick to build and to fetch. The root `/sitemap.xml` (static pages + the first
 * sales) never exceeds that, and `/sales/sitemap/[id].xml` carries the rest.
 */
export const SITEMAP_URL_LIMIT = 5_000;
/** Room kept in the root sitemap for static pages and articles. */
export const ROOT_SITEMAP_SALE_CAPACITY = 4_900;
export const SITEMAP_REVALIDATE_SECONDS = 3_600;
export const SITEMAP_CACHE_TAG = "public-sitemap";
/** PostgREST returns at most 1 000 rows per request. */
const DATABASE_PAGE_SIZE = 1_000;

export type SitemapSale = { id: string; lastModified: string | null };
export type SitemapSalePage = { sales: SitemapSale[]; total: number };

type ErrorLike = { code?: string; message?: string } | null;

type SitemapClient = {
  rpc: (
    fn: "list_public_sale_sitemap_entries",
    args: { p_limit: number; p_offset: number },
  ) => PromiseLike<{ data: unknown; error: unknown }>;
  from: (view: "v_auction_sales_app_preview") => {
    select: (
      columns: "id",
      options: { count: "exact" },
    ) => {
      order: (column: "id") => {
        range: (
          from: number,
          to: number,
        ) => PromiseLike<{
          data: unknown;
          count: number | null;
          error: unknown;
        }>;
      };
    };
  };
};

function isMissingFunction(error: ErrorLike): boolean {
  return (
    !!error &&
    (error.code === "PGRST202" ||
      error.code === "42883" ||
      /list_public_sale_sitemap_entries/.test(error.message ?? ""))
  );
}

/**
 * One page of publicly visible sales, ordered by id. Uses the dedicated RPC
 * (identifier + last update) and falls back to the anonymous preview view
 * (identifier only) while the RPC is not deployed.
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
  if (!error) {
    const rows = (data ?? []) as Array<{
      id: string;
      updated_at: string | null;
      total_count: number | string;
    }>;
    return {
      sales: rows.map((row) => ({ id: row.id, lastModified: row.updated_at ?? null })),
      total: rows.length > 0 ? Number(rows[0].total_count) : offset,
    };
  }
  if (!isMissingFunction(error as ErrorLike)) throw error;

  const fallback = await client
    .from("v_auction_sales_app_preview")
    .select("id", { count: "exact" })
    .order("id")
    .range(offset, offset + DATABASE_PAGE_SIZE - 1);
  if (fallback.error) throw fallback.error;
  const rows = (fallback.data ?? []) as Array<{ id: string }>;
  return {
    sales: rows.map((row) => ({ id: row.id, lastModified: null })),
    total: fallback.count ?? offset + rows.length,
  };
}

const cachedSalePage = unstable_cache(
  async (pageIndex: number): Promise<SitemapSalePage> => {
    const client = createPublicSupabaseClient();
    if (!client) throw new Error("Supabase n'est pas configuré côté serveur.");
    return fetchSitemapSalePage(client as unknown as SitemapClient, pageIndex);
  },
  ["public-sitemap", "sales-page", "v1"],
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

/** Number of additional sitemap files needed beyond the root sitemap. */
export function overflowSitemapCount(total: number): number {
  return total > ROOT_SITEMAP_SALE_CAPACITY
    ? Math.ceil((total - ROOT_SITEMAP_SALE_CAPACITY) / SITEMAP_URL_LIMIT)
    : 0;
}
