import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));

vi.mock("@/integrations/supabase/auth-middleware", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integrations/supabase/auth-middleware")>()),
  requireSupabaseAuthContext: mocks.auth,
}));

const ranges: Array<[string, number, number]> = [];

function builder(table: string) {
  const result = { data: [], error: null, count: 3 };
  const chain: Record<string, unknown> = {
    then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
  };
  for (const method of ["select", "eq", "order"]) chain[method] = () => chain;
  chain.range = (from: number, to: number) => {
    ranges.push([table, from, to]);
    return chain;
  };
  return chain;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: builder },
}));

const url = "https://immojudis.test/api/admin/information-agent/unrouted";

beforeEach(() => {
  ranges.length = 0;
  mocks.auth.mockReset();
});

describe("/api/admin/information-agent/unrouted", () => {
  it("liste les messages non rattachés d'un administrateur, sans cache", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: true, userId: "admin-1" });

    const response = await GET(
      new Request(`${url}?offset=0&limit=20`, { headers: { authorization: "Bearer test-token" } }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ messages: [], total: 3, limit: 20 });
    expect(ranges).toEqual([["information_agent_unrouted_messages", 0, 19]]);
  });

  it("refuse un compte qui n'est pas administrateur", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: false, userId: "user-1" });

    const response = await GET(
      new Request(url, { headers: { authorization: "Bearer test-token" } }),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(ranges).toEqual([]);
  });

  it("refuse une action inconnue", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: true, userId: "admin-1" });

    const response = await POST(
      new Request(url, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({
          action: "reply",
          messageId: "55555555-5555-4555-8555-555555555555",
        }),
      }),
    );

    expect(response.status).toBe(400);
  });
});
