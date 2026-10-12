import { describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (load: (...args: unknown[]) => unknown) => load,
}));

import {
  fetchSitemapSalePage,
  loadSitemapSales,
  loadSitemapSaleTotal,
  overflowSitemapCount,
  ROOT_SITEMAP_SALE_CAPACITY,
  SITEMAP_URL_LIMIT,
  type SitemapSalePage,
} from "./public-sitemap.server";

type Client = Parameters<typeof fetchSitemapSalePage>[0];

describe("sitemap sales page", () => {
  it("reads identifiers and update dates through the dedicated RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        { id: "a", updated_at: "2026-10-09T10:00:00Z", total_count: "2276" },
        { id: "b", updated_at: null, total_count: "2276" },
      ],
      error: null,
    });
    const page = await fetchSitemapSalePage({ rpc } as unknown as Client, 2);
    expect(rpc).toHaveBeenCalledWith("list_public_sale_sitemap_entries", {
      p_limit: 1000,
      p_offset: 2000,
    });
    expect(page).toEqual({
      sales: [
        { id: "a", lastModified: "2026-10-09T10:00:00Z" },
        { id: "b", lastModified: null },
      ],
      total: 2276,
    });
  });

  it("falls back to the preview view while the RPC is not deployed", async () => {
    const range = vi.fn().mockResolvedValue({ data: [{ id: "a" }], count: 1, error: null });
    const client = {
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { code: "PGRST202", message: "Could not find the function" },
      }),
      from: () => ({ select: () => ({ order: () => ({ range }) }) }),
    } as unknown as Client;
    expect(await fetchSitemapSalePage(client, 0)).toEqual({
      sales: [{ id: "a", lastModified: null }],
      total: 1,
    });
    expect(range).toHaveBeenCalledWith(0, 999);
  });

  it("does not hide a real database error behind the fallback", async () => {
    const client = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "57014", message: "timeout" } }),
    } as unknown as Client;
    await expect(fetchSitemapSalePage(client, 0)).rejects.toMatchObject({ code: "57014" });
  });
});

describe("sitemap pagination", () => {
  const sales = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `sale-${from + index}`,
      lastModified: null,
    }));
  const loader =
    (total: number) =>
    async (pageIndex: number): Promise<SitemapSalePage> => ({
      sales: sales(pageIndex * 1000, Math.max(0, Math.min(1000, total - pageIndex * 1000))),
      total,
    });

  it("returns the requested slice across database pages", async () => {
    const result = await loadSitemapSales(900, 2100, loader(2276));
    expect(result).toHaveLength(1200);
    expect(result[0].id).toBe("sale-900");
    expect(result.at(-1)?.id).toBe("sale-2099");
  });

  it("stops at the last sale", async () => {
    expect(await loadSitemapSales(2000, 5000, loader(2276))).toHaveLength(276);
    expect(await loadSitemapSales(10, 10, loader(2276))).toEqual([]);
  });

  it("knows the total from the first page", async () => {
    expect(await loadSitemapSaleTotal(loader(2276))).toBe(2276);
  });

  it("keeps every sitemap file under 5 000 URLs", () => {
    expect(ROOT_SITEMAP_SALE_CAPACITY).toBeLessThan(SITEMAP_URL_LIMIT);
    expect(overflowSitemapCount(2276)).toBe(0);
    expect(overflowSitemapCount(ROOT_SITEMAP_SALE_CAPACITY)).toBe(0);
    expect(overflowSitemapCount(ROOT_SITEMAP_SALE_CAPACITY + 1)).toBe(1);
    expect(overflowSitemapCount(ROOT_SITEMAP_SALE_CAPACITY + SITEMAP_URL_LIMIT)).toBe(1);
    expect(overflowSitemapCount(ROOT_SITEMAP_SALE_CAPACITY + SITEMAP_URL_LIMIT + 1)).toBe(2);
  });
});
