import { beforeEach, describe, expect, it, vi } from "vitest";

const { from } = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from } }));

import { readFloodSales } from "@/lib/flood-risk-store.server";

type Page = Record<string, unknown>[];

/** Un constructeur de requête qui enregistre ses appels et rend la page suivante à chaque `limit`. */
function queryOver(pages: Page[], calls: { gt: string[]; range: number }) {
  let next = 0;
  const query: Record<string, unknown> = {};
  for (const name of ["select", "eq", "order"]) query[name] = () => query;
  query.gt = (_column: string, value: string) => {
    calls.gt.push(value);
    return query;
  };
  query.range = () => {
    calls.range += 1;
    return query;
  };
  query.limit = () => Promise.resolve({ data: pages[next++] ?? [], error: null });
  return query;
}

const idOf = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

describe("readFloodSales", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lit les extraits de position par curseur sur id, sans décalage", async () => {
    const extrasPages: Page[] = [
      Array.from({ length: 1000 }, (_, index) => ({
        id: idOf(index),
        geocode_type: "street",
        geocode_score: "0.4",
        parcels: [{ centroid: [44.8, -0.5] }],
      })),
      [{ id: idOf(1000), geocode_type: null, geocode_score: null, parcels: null }],
    ];
    const salesPages: Page[] = [[{ id: idOf(0), status: "upcoming" }]];
    const extrasCalls = { gt: [] as string[], range: 0 };
    const salesCalls = { gt: [] as string[], range: 0 };
    // Un seul constructeur par table : chaque page lue consomme la page suivante.
    const extrasQuery = queryOver(extrasPages, extrasCalls);
    const salesQuery = queryOver(salesPages, salesCalls);
    from.mockImplementation((table: string) =>
      table === "auction_sales" ? extrasQuery : salesQuery,
    );

    const sales = await readFloodSales();

    expect(extrasCalls.gt).toEqual([idOf(999)]);
    expect(extrasCalls.range).toBe(0);
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({
      id: idOf(0),
      geocodeType: "street",
      geocodeScore: 0.4,
      parcelCentroids: [{ latitude: 44.8, longitude: -0.5 }],
    });
  });
});
