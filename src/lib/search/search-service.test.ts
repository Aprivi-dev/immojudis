import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSales, rpc } = vi.hoisted(() => ({ getSales: vi.fn(), rpc: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc },
}));

vi.mock("@/lib/queries", () => ({
  getSales,
  getSalesCount: vi.fn(),
  getSalesWithCoords: vi.fn(),
}));

import { fetchSearchCount, fetchSearchResults } from "./search-service";

describe("public preview search service", () => {
  beforeEach(() => {
    getSales.mockReset();
    rpc.mockReset();
  });

  it("fetches only the requested authenticated page with a real offset", async () => {
    getSales.mockResolvedValue([]);

    await fetchSearchResults({
      search: { page: 3, limit: 24, sort: "newest" },
      preview: false,
      discovery: true,
    });

    expect(getSales).toHaveBeenCalledWith(expect.any(Object), 24, "date_desc", 48, {
      discovery: true,
    });
  });

  it("deduplicates the preview request and sends expanded region departments", async () => {
    rpc.mockResolvedValue({
      data: [{ id: "sale-33", starting_price_eur: 120_000, total_count: 7 }],
      error: null,
    });

    const search = { query: "Nouvelle-Aquitaine" };
    const [items, count] = await Promise.all([
      fetchSearchResults({ search, preview: true }),
      fetchSearchCount({ search, preview: true }),
    ]);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "search_auction_sales_preview",
      expect.objectContaining({
        p_departments: expect.arrayContaining(["33", "Gironde", "64", "Pyrénées-Atlantiques"]),
        p_keywords: null,
        p_postal_code: null,
      }),
    );
    expect(items).toEqual([{ id: "sale-33", starting_price_eur: 120_000 }]);
    expect(count).toBe(7);
  });

  it("sends a postal code as an exact preview filter", async () => {
    rpc.mockResolvedValue({ data: [], error: null });

    await fetchSearchResults({ search: { query: "33000" }, preview: true });

    expect(rpc).toHaveBeenCalledWith(
      "search_auction_sales_preview",
      expect.objectContaining({
        p_departments: null,
        p_keywords: null,
        p_postal_code: "33000",
      }),
    );
  });

  it("paginates preview RPC results without reloading earlier rows", async () => {
    rpc.mockResolvedValue({ data: [], error: null });

    await fetchSearchResults({ search: { page: 4, limit: 12 }, preview: true });

    expect(rpc).toHaveBeenCalledWith(
      "search_auction_sales_preview",
      expect.objectContaining({ p_limit: 12, p_offset: 36 }),
    );
  });

  it("normalizes an accent-insensitive city query into keyword terms", async () => {
    rpc.mockResolvedValue({ data: [], error: null });

    await fetchSearchResults({ search: { query: "Nîmes centre" }, preview: true });

    expect(rpc).toHaveBeenCalledWith(
      "search_auction_sales_preview",
      expect.objectContaining({ p_keywords: ["nimes", "centre"] }),
    );
  });

  it("never sends protected attributes through the anonymous preview oracle", async () => {
    rpc.mockResolvedValue({ data: [], error: null });

    await fetchSearchResults({
      search: {
        minSqft: 80,
        minBeds: 3,
        occupancy: "vacant",
        minScore: 70,
        viewport: { north: 45, south: 44, east: 1, west: 0 },
      },
      preview: true,
    });

    expect(rpc).toHaveBeenCalledWith(
      "search_auction_sales_preview",
      expect.objectContaining({
        p_min_surface: null,
        p_min_bedrooms: null,
        p_occupancy_status: null,
        p_min_score: null,
        p_north: null,
        p_south: null,
        p_east: null,
        p_west: null,
      }),
    );
  });
});
