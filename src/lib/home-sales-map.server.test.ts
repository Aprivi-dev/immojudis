import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));

import { FRANCE_MAP_HEIGHT, FRANCE_MAP_WIDTH } from "@/lib/home-france-map";
import { homeSalesMapFromSales, loadHomeSalesMap } from "./home-sales-map.server";
import type { AuctionSale } from "@/lib/types";

function sale(fields: Partial<AuctionSale>): AuctionSale {
  return { id: Math.random().toString(36), ...fields } as AuctionSale;
}

describe("homeSalesMapFromSales", () => {
  it("groups nearby sales in one sector, the fullest sectors first", () => {
    const map = homeSalesMapFromSales([
      sale({ latitude: 48.85, longitude: 2.35, starting_price_eur: 90_000 }),
      sale({ latitude: 44.84, longitude: -0.58, starting_price_eur: 1_760 }),
      sale({ latitude: 44.86, longitude: -0.57 }),
      sale({ latitude: 44.83, longitude: -0.6 }),
    ]);
    expect(map.cells.map((cell) => cell.count)).toEqual([3, 1]);
    expect(map.lowestStartingPrice).toBe(1_760);
  });

  it("keeps every sector inside the drawing, and leaves out overseas or missing positions", () => {
    const map = homeSalesMapFromSales([
      sale({ latitude: 51.05, longitude: 2.37 }), // Dunkerque
      sale({ latitude: 41.39, longitude: 9.16 }), // Bonifacio
      sale({ latitude: 43.3, longitude: -1.98 }), // Hendaye, near the western edge
      sale({ latitude: -20.9, longitude: 55.45 }), // La Réunion
      sale({ latitude: null as unknown as number, longitude: 2 }),
    ]);
    expect(map.cells).toHaveLength(3);
    for (const cell of map.cells) {
      expect(cell.x).toBeGreaterThanOrEqual(0);
      expect(cell.x).toBeLessThanOrEqual(FRANCE_MAP_WIDTH);
      expect(cell.y).toBeGreaterThanOrEqual(0);
      expect(cell.y).toBeLessThanOrEqual(FRANCE_MAP_HEIGHT);
    }
  });

  it("counts the venue types present, and ignores prices that are not prices", () => {
    const map = homeSalesMapFromSales([
      sale({ sale_venue_type: "tribunal", starting_price_eur: 0 }),
      sale({ sale_venue_type: "notary", starting_price_eur: null as unknown as number }),
      sale({ sale_venue_type: "unknown" }),
    ]);
    expect(map.venueTypes).toBe(2);
    expect(map.lowestStartingPrice).toBeNull();
  });
});

describe("loadHomeSalesMap", () => {
  it("reads every page of the public search", async () => {
    const rpc = vi.fn(async (_fn: string, args: Record<string, unknown>) => {
      const offset = Number(args.p_offset);
      const rows = Array.from({ length: offset === 0 ? 100 : 50 }, (_, index) => ({
        id: `s-${offset + index}`,
        latitude: 45 + (offset + index) / 1000,
        longitude: 4,
        total_count: 150,
      }));
      return { data: rows, error: null };
    });
    const map = await loadHomeSalesMap({ client: { rpc } });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(map?.cells.reduce((sum, cell) => sum + cell.count, 0)).toBe(150);
  });

  it("returns null on a database error or with no placed sale, never a made-up map", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await loadHomeSalesMap({
        client: { rpc: async () => ({ data: null, error: { message: "x" } }) },
      }),
    ).toBeNull();
    expect(
      await loadHomeSalesMap({ client: { rpc: async () => ({ data: [], error: null }) } }),
    ).toBeNull();
    expect(await loadHomeSalesMap({ client: null })).toBeNull();
  });
});
