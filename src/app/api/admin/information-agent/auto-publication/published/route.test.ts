import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  tables: [] as string[],
  ranges: [] as Array<[string, number, number]>,
}));

vi.mock("@/integrations/supabase/auth-middleware", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integrations/supabase/auth-middleware")>()),
  requireSupabaseAuthContext: mocks.auth,
}));

function builder(table: string) {
  mocks.tables.push(table);
  const result =
    table === "information_agent_auto_publication_decisions"
      ? {
          data: [
            {
              id: "decision-101",
              fact_id: "fact-101",
              fact_key: "surface_m2",
              sale_id: "sale-101",
              decided_at: "2026-11-20T09:00:00.000Z",
            },
          ],
          error: null,
          count: 150,
        }
      : { data: [{ id: "fact-101", display_value: "54 m²" }], error: null, count: null };
  const chain: Record<string, unknown> = {
    then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
  };
  for (const method of ["select", "in", "eq", "gte", "order"]) chain[method] = () => chain;
  chain.range = (from: number, to: number) => {
    mocks.ranges.push([table, from, to]);
    return chain;
  };
  return chain;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: builder },
}));

const get = (query = "") =>
  GET(
    new Request(
      `https://immojudis.test/api/admin/information-agent/auto-publication/published${query}`,
      { headers: { authorization: "Bearer test-token" } },
    ),
  );

beforeEach(() => {
  mocks.tables.length = 0;
  mocks.ranges.length = 0;
  mocks.auth.mockReset();
});

describe("GET /api/admin/information-agent/auto-publication/published", () => {
  it("returns the next page of automatic publications, with the exact total", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: true, userId: "admin-1" });
    const response = await get("?offset=100");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        {
          factId: "fact-101",
          factKey: "surface_m2",
          displayValue: "54 m²",
          saleId: "sale-101",
          publishedAt: "2026-11-20T09:00:00.000Z",
        },
      ],
      total: 150,
    });
    expect(mocks.ranges).toEqual([["information_agent_auto_publication_decisions", 100, 199]]);
  });

  it.each(["?offset=-1", "?offset=x", "?offset=5000"])(
    "rejects the invalid offset %s before any read",
    async (query) => {
      mocks.auth.mockResolvedValue({ isAdmin: true, userId: "admin-1" });
      expect((await get(query)).status).toBe(400);
      expect(mocks.tables).toEqual([]);
    },
  );

  it("denies a non-admin before reading anything", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: false, userId: "user-1" });
    expect((await get("?offset=100")).status).toBe(403);
    expect(mocks.tables).toEqual([]);
  });
});
