import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

/** Reads of the sale itself (the public details are fetched alongside, in the same lookup). */
function summaryReads(supabase: { rpc: ReturnType<typeof vi.fn> }) {
  return supabase.rpc.mock.calls.filter(([fn]) => fn === "get_public_sale_summary").length;
}

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

  describe("identifier merged into another sale", () => {
    const KEPT_ID = "99999999-aaaa-4bbb-8ccc-dddddddddddd";

    /** The sale itself is not public (no summary row); the merge lookup answers `merged`. */
    function mergedClient(merged: unknown) {
      return {
        rpc: vi.fn((fn: string) =>
          Promise.resolve(fn === "get_merged_sale_target" ? merged : { data: [], error: null }),
        ),
        from: vi.fn(),
      };
    }

    it("answers merged, with the kept identifier in lower case", async () => {
      const supabase = mergedClient({ data: KEPT_ID.toUpperCase(), error: null });
      mocks.client.mockReturnValue(supabase);

      expect(await lookupPublicSale(ID)).toEqual({ status: "merged", targetId: KEPT_ID });
      expect(supabase.rpc).toHaveBeenCalledWith("get_merged_sale_target", { p_sale_id: ID });
    });

    it("stays missing when the kept sale is not visible (the database returns nothing)", async () => {
      mocks.client.mockReturnValue(mergedClient({ data: null, error: null }));
      expect(await lookupPublicSale(ID)).toEqual({ status: "missing" });
    });

    it("never redirects to something that is not an identifier, nor to itself", async () => {
      mocks.client.mockReturnValue(mergedClient({ data: "/sales/../admin", error: null }));
      expect(await lookupPublicSale(ID)).toEqual({ status: "missing" });
      mocks.store.clear();
      mocks.client.mockReturnValue(mergedClient({ data: ID, error: null }));
      expect(await lookupPublicSale(ID)).toEqual({ status: "missing" });
    });

    it("does not look for a merge when the sale itself is public", async () => {
      const supabase = client({
        rpc: { data: [{ id: ID, city: "Pau", starting_price_eur: 1 }], error: null },
      });
      mocks.client.mockReturnValue(supabase);
      expect((await lookupPublicSale(ID)).status).toBe("found");
      expect(supabase.rpc.mock.calls.some(([fn]) => fn === "get_merged_sale_target")).toBe(false);
    });

    it("stays missing while the function is not deployed", async () => {
      mocks.client.mockReturnValue(
        mergedClient({ data: null, error: { code: "PGRST202", message: "not found" } }),
      );
      expect(await lookupPublicSale(ID)).toEqual({ status: "missing" });
    });

    it("throws on another database error instead of answering 404", async () => {
      mocks.client.mockReturnValue(
        mergedClient({ data: null, error: { code: "57014", message: "timeout" } }),
      );
      await expect(lookupPublicSale(ID)).rejects.toMatchObject({ code: "57014" });
    });

    it("looks for a merge in the legacy fallback as well", async () => {
      const supabase = {
        rpc: vi.fn((fn: string) =>
          Promise.resolve(
            fn === "get_merged_sale_target"
              ? { data: KEPT_ID, error: null }
              : { data: null, error: { code: "PGRST202", message: "missing" } },
          ),
        ),
        from: vi.fn(() => ({
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
          }),
        })),
      };
      mocks.client.mockReturnValue(supabase);
      expect(await lookupPublicSale(ID)).toEqual({ status: "merged", targetId: KEPT_ID });
    });

    it("is cached like any answer, under the tag of the old identifier", async () => {
      const supabase = mergedClient({ data: KEPT_ID, error: null });
      mocks.client.mockReturnValue(supabase);
      await lookupPublicSale(ID);
      await lookupPublicSale(ID);
      expect(summaryReads(supabase)).toBe(1);
      expect([...mocks.store.values()][0].tags).toEqual([`sale-${ID}`, "public-sales"]);
    });
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

  describe("copie hébergée de la photo", () => {
    const PHOTO = "https://www.licitor.com/photos/maison.jpg";
    const row = { id: ID, city: "Pau", starting_price_eur: 1, thumbnail_url: PHOTO };
    const mirrorRow = {
      source_url: PHOTO,
      path_640: `${ID}/abc-640.webp`,
      path_1600: `${ID}/abc-1600.webp`,
      width: 1600,
      height: 1200,
    };

    function withMirrors(mirrors: unknown) {
      return {
        rpc: vi.fn((fn: string) =>
          Promise.resolve(fn === "sale_photo_mirrors" ? mirrors : { data: [row], error: null }),
        ),
        from: vi.fn(),
      };
    }
    const mirrorReads = (supabase: { rpc: ReturnType<typeof vi.fn> }) =>
      supabase.rpc.mock.calls.filter(([fn]) => fn === "sale_photo_mirrors").length;

    beforeEach(() => {
      vi.stubEnv("NEXT_PUBLIC_PHOTO_MIRROR", "on");
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });
    afterEach(() => vi.unstubAllEnvs());

    it("ajoute la copie à la photo, l'URL d'origine restant celle de la source", async () => {
      const supabase = withMirrors({ data: [mirrorRow], error: null });
      mocks.client.mockReturnValue(supabase);

      const result = await lookupPublicSale(ID);

      expect(result).toMatchObject({
        status: "found",
        sale: { media: [{ url: PHOTO, mirror: { path640: `${ID}/abc-640.webp` } }] },
      });
      expect(mirrorReads(supabase)).toBe(1);
    });

    it("n'est pas gardée dans le cache de données : une panne ne dure pas cinq minutes", async () => {
      const supabase = withMirrors({ data: null, error: { message: "boom" } });
      mocks.client.mockReturnValue(supabase);
      const first = await lookupPublicSale(ID);
      expect(first).toMatchObject({ sale: { media: [{ url: PHOTO }] } });
      expect(JSON.stringify([...mocks.store.values()])).not.toContain("mirror");

      const healthy = withMirrors({ data: [mirrorRow], error: null });
      mocks.client.mockReturnValue(healthy);
      const second = await lookupPublicSale(ID);
      expect(second).toMatchObject({ sale: { media: [{ mirror: { width: 1600 } }] } });
      expect(summaryReads(healthy)).toBe(0);
    });

    it("interrupteur éteint : aucun appel et la même réponse qu'avant", async () => {
      vi.stubEnv("NEXT_PUBLIC_PHOTO_MIRROR", "");
      const supabase = withMirrors({ data: [mirrorRow], error: null });
      mocks.client.mockReturnValue(supabase);

      const result = await lookupPublicSale(ID);

      expect(mirrorReads(supabase)).toBe(0);
      expect(JSON.stringify(result)).not.toContain("mirror");
    });

    it("une vente introuvable ne cherche aucune copie", async () => {
      const supabase = {
        rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
        from: vi.fn(),
      };
      mocks.client.mockReturnValue(supabase);
      expect(await lookupPublicSale(ID)).toEqual({ status: "missing" });
      expect(mirrorReads(supabase)).toBe(0);
    });
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
      expect(summaryReads(supabase)).toBe(1);
    });

    it("caches a missing sale as well, per sale", async () => {
      const supabase = client({ rpc: { data: [], error: null } });
      mocks.client.mockReturnValue(supabase);
      await lookupPublicSale(ID);
      await lookupPublicSale(ID);
      expect(summaryReads(supabase)).toBe(1);
      await lookupPublicSale(OTHER_ID);
      expect(summaryReads(supabase)).toBe(2);
    });

    it("shares one entry between the lower- and upper-case spellings of an identifier", async () => {
      const supabase = client({ rpc: { data: [row], error: null } });
      mocks.client.mockReturnValue(supabase);
      await lookupPublicSale(ID);
      await lookupPublicSale(ID.toUpperCase());
      expect(summaryReads(supabase)).toBe(1);
    });

    it("reads again after the sale tag is invalidated", async () => {
      const supabase = client({ rpc: { data: [row], error: null } });
      mocks.client.mockReturnValue(supabase);
      await lookupPublicSale(ID);
      revalidateTag(publicSaleCacheTag(ID));
      await lookupPublicSale(ID);
      expect(summaryReads(supabase)).toBe(2);
    });

    it("keeps the other sales cached when one tag is invalidated", async () => {
      const supabase = client({ rpc: { data: [row], error: null } });
      mocks.client.mockReturnValue(supabase);
      await lookupPublicSale(ID);
      await lookupPublicSale(OTHER_ID);
      revalidateTag(publicSaleCacheTag(ID));
      await lookupPublicSale(OTHER_ID);
      expect(summaryReads(supabase)).toBe(2);
    });

    it("tags entries sale-<id> and the global public-sales tag, and revalidates them after five minutes", async () => {
      mocks.client.mockReturnValue(client({ rpc: { data: [row], error: null } }));
      await lookupPublicSale(ID.toUpperCase());
      expect(publicSaleCacheTag(ID.toUpperCase())).toBe(`sale-${ID}`);
      expect([...mocks.store.values()][0].tags).toEqual([`sale-${ID}`, "public-sales"]);
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
