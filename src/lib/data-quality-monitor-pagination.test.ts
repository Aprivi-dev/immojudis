import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn(), ranges: vi.fn(), visible: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: async () => ({ userId: "admin", isAdmin: true }),
}));

import { getDataQualityReport } from "@/lib/data-quality-monitor";

beforeEach(() => vi.resetAllMocks());

function mockCatalogue(hidden: Set<string> = new Set()) {
  const rows = Array.from({ length: 251 }, (_, index) => ({
    id: `sale-${index}`,
    title: "Vente de test",
    sale_date: "2026-11-01T12:00:00Z",
    status: "active",
  }));
  const candidateQuery = {
    order: vi.fn().mockReturnThis(),
    range: mocks.ranges.mockImplementation(async (from: number, to: number) => ({
      data: rows.slice(from, to + 1).map(({ id }) => ({ id })),
      error: null,
    })),
  };
  const visibleQuery = {
    in: mocks.visible.mockImplementation(async (_column: string, ids: string[]) => ({
      data: rows.filter((row) => ids.includes(row.id) && !hidden.has(row.id)),
      error: null,
    })),
  };
  const runsQuery = {
    order: vi.fn().mockReturnThis(),
    limit: async () => ({ data: [], error: null }),
  };
  mocks.from.mockImplementation((table: string) => ({
    select: () =>
      table === "auction_runs"
        ? runsQuery
        : table === "auction_sales"
          ? candidateQuery
          : visibleQuery,
  }));
}

it("bounds view inputs by candidate IDs and keeps the complete report across pages", async () => {
  mockCatalogue();
  const report = await getDataQualityReport("test-token");
  expect(mocks.ranges.mock.calls).toEqual([
    [0, 249],
    [250, 499],
  ]);
  expect(mocks.visible.mock.calls.map(([column, ids]) => [column, ids.length])).toEqual([
    ["id", 250],
    ["id", 1],
  ]);
  expect(report.sampleSize).toBe(251);
  expect(report.capped).toBe(false);
  expect(report.sourceCoverage.reduce((total, source) => total + source.count, 0)).toBe(251);
  expect(report.prioritySales).toHaveLength(12);
});

it("continues after a completely hidden batch and never exposes filtered candidates", async () => {
  mockCatalogue(new Set(Array.from({ length: 250 }, (_, index) => `sale-${index}`)));
  const report = await getDataQualityReport("test-token");
  expect(mocks.ranges).toHaveBeenCalledTimes(2);
  expect(report.sampleSize).toBe(1);
  expect(report.prioritySales.map((sale) => sale.id)).toEqual(["sale-250"]);
});
