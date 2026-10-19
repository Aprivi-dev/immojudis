import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPublicSaleSummary } from "./public-sale-summary";
import { loadWithdrawnSources, resetWithdrawnSources } from "./withdrawn-sources";

/**
 * The E2E server answers the server-side Supabase reads of a sale page with
 * `e2e/support/server-fetch-mock.cjs` (the build points Supabase at a host that does not exist).
 * `readPublicSale` (src/lib/public-sale.server.ts) makes these reads: if it gains one the preload
 * does not answer, every sale page of the E2E build answers 500. Same reads, same order here.
 */
const SALE_ID = "11111111-1111-4111-8111-111111111111";
const realFetch = globalThis.fetch;
const network = vi.fn(async (input: RequestInfo | URL) => {
  throw new TypeError(`fetch failed: ${String(input)} reached the network`);
});

beforeAll(() => {
  globalThis.fetch = network as unknown as typeof fetch;
  createRequire(import.meta.url)("../../e2e/support/server-fetch-mock.cjs");
});
beforeEach(() => {
  network.mockClear();
});
afterAll(() => {
  globalThis.fetch = realFetch;
  resetWithdrawnSources();
});

function client() {
  return createClient("https://ci.supabase.co", "ci-publishable-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

describe("E2E server fetch mock", () => {
  it("answers every server read of a sale page without reaching the network", async () => {
    const supabase = client();
    resetWithdrawnSources();
    await expect(loadWithdrawnSources(supabase)).resolves.toEqual([]);

    const result = await fetchPublicSaleSummary(supabase, SALE_ID, { withIndexability: true });

    expect(result.kind).toBe("found");
    if (result.kind !== "found") return;
    expect(result.sale).toMatchObject({ id: SALE_ID, city: "Lyon" });
    expect(result.indexable).toBe(true);
    expect(network).not.toHaveBeenCalled();
  });

  it("still reports another sale as missing", async () => {
    const result = await fetchPublicSaleSummary(client(), "22222222-2222-4222-8222-222222222222", {
      withIndexability: true,
    });
    expect(result.kind).toBe("missing");
    expect(network).not.toHaveBeenCalled();
  });

  it("lets other requests through", async () => {
    const url = "https://ci.supabase.co/rest/v1/v_auction_sales_discovery?select=id";
    await expect(fetch(url)).rejects.toThrow("reached the network");
    await expect(fetch("https://example.test/")).rejects.toThrow("reached the network");
    expect(network).toHaveBeenCalledTimes(2);
  });
});
