import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), tables: [] as string[] }));

vi.mock("@/integrations/supabase/auth-middleware", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integrations/supabase/auth-middleware")>()),
  requireSupabaseAuthContext: mocks.auth,
}));

const ranges: Array<[string, number, number]> = [];

function builder(table: string) {
  mocks.tables.push(table);
  const result =
    table === "information_agent_fact_candidates"
      ? { data: [], error: null, count: 130 }
      : table === "information_agent_messages"
        ? { data: [], error: null, count: 12 }
        : { data: [], error: null, count: null };
  const chain: Record<string, unknown> = {
    then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
  };
  for (const method of ["select", "in", "eq", "order"]) chain[method] = () => chain;
  chain.range = (from: number, to: number) => {
    ranges.push([table, from, to]);
    return chain;
  };
  return chain;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: builder },
}));

const get = (query = "") =>
  GET(
    new Request(`https://immojudis.test/api/admin/information-agent${query}`, {
      headers: { authorization: "Bearer test-token" },
    }),
  );

beforeEach(() => {
  mocks.tables.length = 0;
  ranges.length = 0;
  mocks.auth.mockReset();
});

describe("GET /api/admin/information-agent", () => {
  it("pages both lists with offset/limit and returns their totals", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: true, userId: "admin-1" });

    const response = await get("?offset=50&limit=50");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      facts: [],
      messages: [],
      factsTotal: 130,
      messagesTotal: 12,
      total: 130,
      offset: 50,
      limit: 50,
      hasMore: true,
    });
    expect(ranges).toEqual([
      ["information_agent_fact_candidates", 50, 99],
      ["information_agent_messages", 50, 99],
    ]);
  });

  it("defaults to the first 50 rows", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: true, userId: "admin-1" });
    const body = await (await get()).json();
    expect(body).toMatchObject({ offset: 0, limit: 50 });
    expect(ranges[0]).toEqual(["information_agent_fact_candidates", 0, 49]);
  });

  it.each(["?limit=0", "?limit=101", "?offset=-5", "?offset=x", "?factCursor=abc&limit=-1"])(
    "rejects the invalid query %s before any read",
    async (query) => {
      mocks.auth.mockResolvedValue({ isAdmin: true, userId: "admin-1" });
      expect((await get(query)).status).toBe(400);
      expect(mocks.tables).toEqual([]);
    },
  );

  it("denies a non-admin before reading anything", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: false, userId: "user-1" });
    expect((await get()).status).toBe(403);
    expect(mocks.tables).toEqual([]);
  });
});
