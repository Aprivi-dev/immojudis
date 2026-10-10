import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: vi.fn(),
  store: new Map<string, { value: unknown; tags: string[]; expiresAt: number }>(),
  revalidateSeconds: [] as Array<number | false | undefined>,
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  // React's per-request memoization is not available outside a render.
  return { ...actual, cache: <T extends (...args: never[]) => unknown>(fn: T) => fn };
});
// In-memory stand-in for the Next.js data cache: entries keyed by key parts, tagged,
// expiring after `revalidate` seconds. Thrown errors are not stored, like the real one.
vi.mock("next/cache", () => ({
  unstable_cache:
    <T>(
      fn: () => Promise<T>,
      keyParts: string[],
      options: { tags?: string[]; revalidate?: number | false },
    ) =>
    async (): Promise<T> => {
      mocks.revalidateSeconds.push(options.revalidate);
      const key = keyParts.join("/");
      const hit = mocks.store.get(key);
      if (hit && hit.expiresAt > Date.now()) return structuredClone(hit.value) as T;
      const value = await fn();
      const ttl = typeof options.revalidate === "number" ? options.revalidate * 1000 : Infinity;
      mocks.store.set(key, {
        value: structuredClone(value),
        tags: options.tags ?? [],
        expiresAt: Date.now() + ttl,
      });
      return value;
    },
}));
vi.mock("@/lib/supabase-public.server", () => ({ createPublicSupabaseClient: mocks.client }));

import {
  lookupPublicSale,
  PUBLIC_SALE_REVALIDATE_SECONDS,
  publicSaleCacheTag,
} from "./public-sale.server";

const ID = "005a914d-563c-427b-88a4-740cbf851afb";
const OTHER_ID = "11111111-2222-4333-8444-555555555555";

function client({ rpc, view }: { rpc: unknown; view?: unknown }) {
  return {
    rpc: vi.fn().mockResolvedValue(rpc),
    from: vi.fn(() => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(view) }) }),
    })),
  };
}

/** What `revalidateTag` does to the real cache: drop every entry carrying the tag. */
function revalidateTag(tag: string) {
  for (const [key, entry] of mocks.store) if (entry.tags.includes(tag)) mocks.store.delete(key);
}

describe("public sale lookup", () => {
  beforeEach(() => {
    mocks.client.mockReset();
    mocks.store.clear();
    mocks.revalidateSeconds.length = 0;
  });

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

  describe("data cache", () => {
    const row = { id: ID, city: "Pau", starting_price_eur: 1 };

    it("reads the database once for a sale served twice in a row", async () => {
      const supabase = client({ rpc: { data: [row], error: null } });
      mocks.client.mockReturnValue(supabase);

      const first = await lookupPublicSale(ID);
      const second = await lookupPublicSale(ID);

      expect(first.status).toBe("found");
      expect(second).toEqual(first);
      expect(supabase.rpc).toHaveBeenCalledTimes(1);
    });

    it("caches a missing sale as well, per sale", async () => {
      const supabase = client({ rpc: { data: [], error: null } });
      mocks.client.mockReturnValue(supabase);
      await lookupPublicSale(ID);
      await lookupPublicSale(ID);
      expect(supabase.rpc).toHaveBeenCalledTimes(1);
      await lookupPublicSale(OTHER_ID);
      expect(supabase.rpc).toHaveBeenCalledTimes(2);
    });

    it("shares one entry between the lower- and upper-case spellings of an identifier", async () => {
      const supabase = client({ rpc: { data: [row], error: null } });
      mocks.client.mockReturnValue(supabase);
      await lookupPublicSale(ID);
      await lookupPublicSale(ID.toUpperCase());
      expect(supabase.rpc).toHaveBeenCalledTimes(1);
    });

    it("reads again after the sale tag is invalidated", async () => {
      const supabase = client({ rpc: { data: [row], error: null } });
      mocks.client.mockReturnValue(supabase);
      await lookupPublicSale(ID);
      revalidateTag(publicSaleCacheTag(ID));
      await lookupPublicSale(ID);
      expect(supabase.rpc).toHaveBeenCalledTimes(2);
    });

    it("keeps the other sales cached when one tag is invalidated", async () => {
      const supabase = client({ rpc: { data: [row], error: null } });
      mocks.client.mockReturnValue(supabase);
      await lookupPublicSale(ID);
      await lookupPublicSale(OTHER_ID);
      revalidateTag(publicSaleCacheTag(ID));
      await lookupPublicSale(OTHER_ID);
      expect(supabase.rpc).toHaveBeenCalledTimes(2);
    });

    it("tags entries sale-<id> and revalidates them after five minutes", async () => {
      mocks.client.mockReturnValue(client({ rpc: { data: [row], error: null } }));
      await lookupPublicSale(ID.toUpperCase());
      expect(publicSaleCacheTag(ID.toUpperCase())).toBe(`sale-${ID}`);
      expect([...mocks.store.values()][0].tags).toEqual([`sale-${ID}`]);
      expect(mocks.revalidateSeconds).toEqual([300]);
      expect(PUBLIC_SALE_REVALIDATE_SECONDS).toBe(300);
    });

    it("never stores a database error nor the unavailable answer", async () => {
      mocks.client.mockReturnValue(
        client({ rpc: { data: null, error: { code: "57014", message: "timeout" } } }),
      );
      await expect(lookupPublicSale(ID)).rejects.toMatchObject({ code: "57014" });
      expect(mocks.store.size).toBe(0);

      mocks.client.mockReturnValue(null);
      expect(await lookupPublicSale(ID)).toEqual({ status: "unavailable" });
      expect(mocks.store.size).toBe(0);
    });

    it("does not touch the database or the cache for a malformed identifier", async () => {
      expect(await lookupPublicSale("nope")).toEqual({ status: "missing" });
      expect(mocks.client).not.toHaveBeenCalled();
      expect(mocks.store.size).toBe(0);
    });

    it("keeps the page revalidation window equal to the data-cache one", () => {
      const page = readFileSync("src/app/sales/[id]/page.tsx", "utf8");
      expect(page).toContain(`export const revalidate = ${PUBLIC_SALE_REVALIDATE_SECONDS};`);
    });
  });
});
