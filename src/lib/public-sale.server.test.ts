import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ client: vi.fn() }));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  // React's per-request memoization is not available outside a render.
  return { ...actual, cache: <T extends (...args: never[]) => unknown>(fn: T) => fn };
});
vi.mock("@/lib/supabase-public.server", () => ({ createPublicSupabaseClient: mocks.client }));

import { lookupPublicSale } from "./public-sale.server";

const ID = "005a914d-563c-427b-88a4-740cbf851afb";

function client({ rpc, view }: { rpc: unknown; view?: unknown }) {
  return {
    rpc: vi.fn().mockResolvedValue(rpc),
    from: vi.fn(() => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(view) }) }),
    })),
  };
}

describe("public sale lookup", () => {
  beforeEach(() => mocks.client.mockReset());

  it("finds a public sale", async () => {
    mocks.client.mockReturnValue(
      client({ rpc: { data: [{ id: ID, city: "Pau", starting_price_eur: 1 }], error: null } }),
    );
    const result = await lookupPublicSale(ID);
    expect(result.status).toBe("found");
  });

  it("answers missing for an unknown sale and for a malformed identifier", async () => {
    mocks.client.mockReturnValue(client({ rpc: { data: [], error: null } }));
    expect(await lookupPublicSale(ID)).toEqual({ status: "missing" });
    expect(await lookupPublicSale("nope")).toEqual({ status: "missing" });
  });

  it("falls back to the minimal preview view before the function is deployed", async () => {
    mocks.client.mockReturnValue(
      client({
        rpc: { data: null, error: { code: "PGRST202", message: "missing" } },
        view: { data: { id: ID, starting_price_eur: 30_000 }, error: null },
      }),
    );
    const result = await lookupPublicSale(ID);
    expect(result).toMatchObject({ status: "found", sale: { id: ID, starting_price_eur: 30_000 } });
  });

  it("is missing in the legacy fallback too when the view has no row", async () => {
    mocks.client.mockReturnValue(
      client({
        rpc: { data: null, error: { code: "PGRST202", message: "missing" } },
        view: { data: null, error: null },
      }),
    );
    expect(await lookupPublicSale(ID)).toEqual({ status: "missing" });
  });

  it("throws on a database error instead of answering 404", async () => {
    mocks.client.mockReturnValue(
      client({ rpc: { data: null, error: { code: "57014", message: "timeout" } } }),
    );
    await expect(lookupPublicSale(ID)).rejects.toMatchObject({ code: "57014" });
  });

  it("lets the browser decide when the server has no database access", async () => {
    mocks.client.mockReturnValue(null);
    expect(await lookupPublicSale(ID)).toEqual({ status: "unavailable" });
  });
});
