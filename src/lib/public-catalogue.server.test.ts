import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cacheDeclarations = vi.hoisted(() => [] as Array<{ keyParts: string[]; options: unknown }>);

vi.mock("next/cache", () => ({
  // The data cache is replaced by a pass-through in unit tests; its declarations are recorded.
  unstable_cache: (load: (...args: unknown[]) => unknown, keyParts: string[], options: unknown) => {
    cacheDeclarations.push({ keyParts, options });
    return load;
  },
}));

import {
  FIRST_PAGE_CACHE_KEY,
  isDefaultCatalogueSearch,
  loadInitialCatalogue,
} from "./public-catalogue.server";
import { salesSearchSignature } from "./search/search-url-state";

const page = (ids: string[], count = ids.length) => ({
  items: ids.map((id) => ({ id })) as never[],
  count,
});

describe("cache of the first page", () => {
  it("passe en v2 : l'ordre par défaut (complétude) et le palier de chaque carte ont changé", () => {
    expect(FIRST_PAGE_CACHE_KEY).toEqual(["public-catalogue", "first-page", "v2"]);
    expect(cacheDeclarations).toHaveLength(1);
    expect(cacheDeclarations[0].keyParts).toEqual(["public-catalogue", "first-page", "v2"]);
    expect(cacheDeclarations[0].options).toMatchObject({
      revalidate: 300,
      tags: ["public-catalogue"],
    });
  });
});

describe("initial catalogue rendered on the server", () => {
  const search = vi.fn();
  const firstPage = vi.fn();

  beforeEach(() => {
    search.mockReset();
    firstPage.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("serves the unfiltered first page from the shared cache", async () => {
    firstPage.mockResolvedValue(page(["a", "b"], 2276));
    const result = await loadInitialCatalogue({}, { search, firstPage });
    expect(result).toEqual({
      signature: "[]",
      items: [{ id: "a" }, { id: "b" }],
      count: 2276,
    });
    expect(firstPage).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled();
  });

  it("does not cache filtered searches: each one reads the database", async () => {
    search.mockResolvedValue(page(["c"]));
    const filters = { city: "Pau" };
    const result = await loadInitialCatalogue(filters, { search, firstPage });
    expect(search).toHaveBeenCalledWith(filters);
    expect(firstPage).not.toHaveBeenCalled();
    expect(result?.signature).toBe(salesSearchSignature(filters));
  });

  it("treats page 1 and the default sort as the unfiltered catalogue", () => {
    expect(isDefaultCatalogueSearch({ page: 1, sort: "relevance" })).toBe(true);
    expect(isDefaultCatalogueSearch({ page: 2 })).toBe(false);
    expect(isDefaultCatalogueSearch({ limit: 12 })).toBe(false);
  });

  it("never lists the demonstration sales", async () => {
    firstPage.mockResolvedValue(page(["example-immojudis-bordeaux-t2", "real"]));
    const result = await loadInitialCatalogue({}, { search, firstPage });
    expect(result?.items.map((sale) => sale.id)).toEqual(["real"]);
  });

  it("falls back to the browser when the database fails", async () => {
    search.mockRejectedValue(new Error("statement timeout"));
    expect(await loadInitialCatalogue({ city: "Pau" }, { search, firstPage })).toBeNull();
  });

  it("falls back to the browser when the database is too slow", async () => {
    search.mockReturnValue(new Promise(() => undefined));
    expect(
      await loadInitialCatalogue({ city: "Pau" }, { search, firstPage, timeoutMs: 5 }),
    ).toBeNull();
  });

  it("leaves oversized pages to the browser instead of failing the render", async () => {
    expect(await loadInitialCatalogue({ limit: 500 }, { search, firstPage })).toBeNull();
    expect(search).not.toHaveBeenCalled();
  });
});

describe("copies hébergées des photos de la première page", () => {
  const PHOTO_A = "https://www.licitor.com/photos/a.jpg";
  const PHOTO_B = "https://www.vench.fr/vignettes/v1.jpg";
  const search = vi.fn();
  const firstPage = vi.fn();
  const mirrorRpc = vi.fn();
  const photoMirrorClient = { rpc: mirrorRpc };

  const withPhotos = () => ({
    items: [
      { id: "a", media: [{ type: "image", url: PHOTO_A }] },
      { id: "b", media: [{ type: "image", url: PHOTO_B }] },
      { id: "c", media: [] },
    ] as never[],
    count: 3,
  });
  const mirrorRow = (sourceUrl: string, path: string) => ({
    source_url: sourceUrl,
    path_640: `${path}-640.webp`,
    path_1600: `${path}-1600.webp`,
    width: 1600,
    height: 1200,
  });

  beforeEach(() => {
    search.mockReset();
    firstPage.mockReset().mockResolvedValue(withPhotos());
    mirrorRpc.mockReset().mockResolvedValue({ data: [], error: null });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("NEXT_PUBLIC_PHOTO_MIRROR", "on");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("ajoute les copies avec un seul appel pour toute la page", async () => {
    mirrorRpc.mockResolvedValue({ data: [mirrorRow(PHOTO_A, "a/x")], error: null });

    const result = await loadInitialCatalogue({}, { search, firstPage, photoMirrorClient });

    expect(mirrorRpc).toHaveBeenCalledTimes(1);
    expect(mirrorRpc).toHaveBeenCalledWith("sale_photo_mirrors", {
      p_source_urls: [PHOTO_A, PHOTO_B],
    });
    const [a, b] = result!.items;
    expect(a!.media![0]).toMatchObject({ url: PHOTO_A, mirror: { path640: "a/x-640.webp" } });
    expect(b!.media![0]).toEqual({ type: "image", url: PHOTO_B });
    expect(result!.count).toBe(3);
  });

  it("passe par le cache de données des copies : 5 minutes, clé sur les URL", async () => {
    mirrorRpc.mockResolvedValue({ data: [mirrorRow(PHOTO_A, "a/x")], error: null });
    cacheDeclarations.length = 0;

    await loadInitialCatalogue({}, { search, firstPage, photoMirrorClient });

    expect(cacheDeclarations).toHaveLength(1);
    expect(cacheDeclarations[0]!.keyParts.slice(0, 2)).toEqual(["photo-mirrors", "v1"]);
    expect(cacheDeclarations[0]!.options).toMatchObject({ revalidate: 300 });
  });

  it("enrichit aussi une recherche filtrée, après sa lecture", async () => {
    search.mockResolvedValue(withPhotos());
    mirrorRpc.mockResolvedValue({ data: [mirrorRow(PHOTO_B, "b/y")], error: null });

    const result = await loadInitialCatalogue(
      { city: "Pau" },
      { search, firstPage, photoMirrorClient },
    );

    expect(result!.items[1]!.media![0]!.mirror?.path640).toBe("b/y-640.webp");
  });

  it("interrupteur éteint : aucun appel, page identique", async () => {
    vi.stubEnv("NEXT_PUBLIC_PHOTO_MIRROR", "off");

    const result = await loadInitialCatalogue({}, { search, firstPage, photoMirrorClient });

    expect(mirrorRpc).not.toHaveBeenCalled();
    expect(result!.items).toEqual(withPhotos().items);
  });

  it("une erreur de la fonction ne retire pas la page rendue côté serveur", async () => {
    mirrorRpc.mockResolvedValue({ data: null, error: { message: "boom" } });

    const result = await loadInitialCatalogue({}, { search, firstPage, photoMirrorClient });

    expect(result).not.toBeNull();
    expect(result!.items).toEqual(withPhotos().items);
  });

  it("un délai dépassé (300 ms) rend la page sans copie, sans attendre la fonction", async () => {
    vi.useFakeTimers();
    try {
      mirrorRpc.mockReturnValue(new Promise(() => undefined));
      const pending = loadInitialCatalogue({}, { search, firstPage, photoMirrorClient });
      await vi.advanceTimersByTimeAsync(300);
      const result = await pending;

      expect(result!.items).toEqual(withPhotos().items);
      expect(console.warn).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
