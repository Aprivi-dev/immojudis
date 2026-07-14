import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc },
}));

vi.mock("@/lib/queries", () => ({
  getSales: vi.fn(),
  getSalesCount: vi.fn(),
  getSalesWithCoords: vi.fn(),
}));

import { fetchSearchCount, fetchSearchResults } from "./search-service";

describe("public preview search service", () => {
  beforeEach(() => rpc.mockReset());

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

  it("normalizes an accent-insensitive city query into keyword terms", async () => {
    rpc.mockResolvedValue({ data: [], error: null });

    await fetchSearchResults({ search: { query: "Nîmes centre" }, preview: true });

    expect(rpc).toHaveBeenCalledWith(
      "search_auction_sales_preview",
      expect.objectContaining({ p_keywords: ["nimes", "centre"] }),
    );
  });
});
