import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSales, getSalesCount, getSalesForSearch, getSaleMapPoints, rpc } = vi.hoisted(() => ({
  getSales: vi.fn(),
  getSalesCount: vi.fn(),
  getSalesForSearch: vi.fn(),
  getSaleMapPoints: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc },
}));

vi.mock("@/lib/queries", () => ({
  getSales,
  getSalesForSearch,
  getSalesCount,
  getSaleMapPoints,
}));

import { forgetRememberedPhotoMirrors } from "@/lib/photo-mirror";
import {
  fetchSearchCount,
  fetchSearchMapResults,
  fetchSearchPhotoMirrors,
  fetchSearchResults,
} from "./search-service";

describe("public preview search service", () => {
  const PHOTO = "https://www.licitor.com/photos/maison.jpg";
  const PHOTO_B = "https://www.vench.fr/vignettes/v1.jpg";
  const mirror = {
    path640: "s/abc-640.webp",
    path1600: "s/abc-1600.webp",
    width: 1600,
    height: 1200,
  };
  const publicSales = [
    {
      id: "a",
      starting_price_eur: 90000,
      city: "Bordeaux",
      department: "33",
      app_surface_m2: 60,
      latitude: 44.84,
      longitude: -0.58,
      media: [{ type: "image", url: PHOTO }],
    },
    { id: "b", starting_price_eur: 120000, city: "Pau", media: [{ type: "image", url: PHOTO_B }] },
  ];

  /** Réponse de la route `/api/catalogue/preview`. */
  function previewResponse(
    body: Partial<{ items: unknown[]; count: number; mirrors: unknown[] }> = {},
    status = 200,
  ) {
    return new Response(
      JSON.stringify(
        status === 200
          ? { items: publicSales, count: 2276, mirrors: [[PHOTO, mirror]], ...body }
          : { ok: false, error: "Catalogue indisponible." },
      ),
      { status, headers: { "content-type": "application/json" } },
    );
  }
  const fetchMock = vi.fn();
  const requestedUrls = () => fetchMock.mock.calls.map(([url]) => String(url));

  beforeEach(() => {
    getSales.mockReset();
    getSalesForSearch.mockReset();
    getSaleMapPoints.mockReset();
    rpc.mockReset();
    fetchMock.mockReset().mockImplementation(() => Promise.resolve(previewResponse()));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    forgetRememberedPhotoMirrors();
  });

  describe("visiteur anonyme : un seul aller-retour sur notre domaine", () => {
    beforeEach(() => {
      vi.stubEnv("NEXT_PUBLIC_PHOTO_MIRROR", "on");
    });

    it("demande la page à /api/catalogue/preview et jamais à Supabase", async () => {
      const items = await fetchSearchResults({ search: { department: "33" }, preview: true });

      expect(requestedUrls()).toEqual(["/api/catalogue/preview?department=33"]);
      expect(rpc).not.toHaveBeenCalled();
      expect(items.map((sale) => sale.id)).toEqual(["a", "b"]);
    });

    it("pose les copies de photos de la réponse, sans second appel", async () => {
      const [first, second] = await fetchSearchResults({ search: {}, preview: true });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(rpc).not.toHaveBeenCalled();
      expect(first!.media![0]).toMatchObject({ url: PHOTO, mirror: { path640: mirror.path640 } });
      expect(second!.media![0]).toEqual({ type: "image", url: PHOTO_B });
    });

    it("garde la carte au même format pour la carte Mapbox (coordonnées publiques)", async () => {
      const [sale] = await fetchSearchResults({ search: {}, preview: true });
      const { buildMapboxSaleFeatureCollection } = await import("@/lib/mapbox-sales");

      expect(buildMapboxSaleFeatureCollection([sale!]).features[0]!.geometry.coordinates).toEqual([
        -0.58, 44.84,
      ]);
    });

    it("partage un seul appel entre la liste et le total d'une même recherche", async () => {
      const search = { query: "Nouvelle-Aquitaine", page: 2 };
      const [items, count] = await Promise.all([
        fetchSearchResults({ search, preview: true }),
        fetchSearchCount({ search, preview: true }),
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(items).toHaveLength(2);
      expect(count).toBe(2276);
    });

    it("sépare les recherches différentes et refait l'appel quand la précédente est terminée", async () => {
      await Promise.all([
        fetchSearchResults({ search: { saleType: "notary", page: 2 }, preview: true }),
        fetchSearchResults({ search: { saleType: "tribunal", page: 2 }, preview: true }),
      ]);
      expect(requestedUrls().sort()).toEqual([
        "/api/catalogue/preview?page=2&saleType=notary",
        "/api/catalogue/preview?page=2&saleType=tribunal",
      ]);

      await fetchSearchResults({ search: { saleType: "notary", page: 2 }, preview: true });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("n'envoie que les critères publics, dans un ordre stable", async () => {
      await fetchSearchResults({
        search: {
          sort: "price_asc",
          city: "Bordeaux",
          minSqft: 80,
          minBeds: 3,
          minSaleDate: "2026-09-11",
          maxSaleDate: "2026-10-01",
          page: 4,
          limit: 12,
          occupancy: "vacant",
          minScore: 70,
          dpeClasses: ["A"],
          viewport: { north: 45, south: 44, east: 1, west: 0 },
        },
        preview: true,
      });

      const url = new URL(requestedUrls()[0]!, "https://example.test");
      expect(url.pathname).toBe("/api/catalogue/preview");
      expect([...url.searchParams.keys()]).toEqual([
        "city",
        "limit",
        "maxSaleDate",
        "minBeds",
        "minSaleDate",
        "minSqft",
        "page",
        "sort",
      ]);
    });

    it("compte : lit le total de la même réponse", async () => {
      await expect(fetchSearchCount({ search: {}, preview: true })).resolves.toBe(2276);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("un rafraîchissement sans copie ne retire pas la copie déjà connue", async () => {
      vi.stubGlobal("window", {});
      await fetchSearchResults({ search: {}, preview: true });

      fetchMock.mockImplementation(() => Promise.resolve(previewResponse({ mirrors: [] })));
      const refreshed = await fetchSearchResults({ search: {}, preview: true });

      expect(refreshed[0]!.media![0]).toMatchObject({
        url: PHOTO,
        mirror: { path640: mirror.path640 },
      });
      expect(refreshed[1]!.media![0]).toEqual({ type: "image", url: PHOTO_B });
    });

    it("réponse sans copie : les photos des sources, comme avant", async () => {
      fetchMock.mockImplementation(() => Promise.resolve(previewResponse({ mirrors: [] })));

      const items = await fetchSearchResults({ search: {}, preview: true });

      expect(JSON.stringify(items)).not.toContain("mirror");
    });

    it("n'affiche aucun champ réservé même si la réponse en contenait", async () => {
      const items = await fetchSearchResults({ search: {}, preview: true });

      for (const key of ["address", "lawyer_contact", "documents", "investment_score"]) {
        expect(items[0]).not.toHaveProperty(key);
      }
    });

    it.each([400, 429, 503])(
      "une réponse %i lève une erreur (affichée par la page, comme avant)",
      async (status) => {
        fetchMock.mockImplementation(() => Promise.resolve(previewResponse({}, status)));

        await expect(fetchSearchResults({ search: {}, preview: true })).rejects.toMatchObject({
          status,
        });
        // L'échec ne reste pas en mémoire : la tentative suivante refait l'appel.
        fetchMock.mockImplementation(() => Promise.resolve(previewResponse()));
        await expect(fetchSearchResults({ search: {}, preview: true })).resolves.toHaveLength(2);
      },
    );

    it.each([
      ["une page HTML (proxy, CDN)", () => new Response("<html>502</html>", { status: 200 })],
      ["un corps vide", () => new Response("", { status: 200 })],
      ["un JSON null", () => new Response("null", { status: 200 })],
      ["des ventes absentes", () => new Response(JSON.stringify({ count: 3 }), { status: 200 })],
      [
        "des ventes qui ne sont pas une liste",
        () => new Response(JSON.stringify({ items: {}, count: 3 }), { status: 200 }),
      ],
      [
        "un total absent",
        () => new Response(JSON.stringify({ items: publicSales }), { status: 200 }),
      ],
      [
        "un total en texte",
        () => new Response(JSON.stringify({ items: publicSales, count: "2276" }), { status: 200 }),
      ],
    ])("une réponse 200 avec %s lève une erreur lisible", async (_label, response) => {
      fetchMock.mockImplementation(() => Promise.resolve(response()));

      for (const call of [
        () => fetchSearchResults({ search: {}, preview: true }),
        () => fetchSearchCount({ search: {}, preview: true }),
      ]) {
        const failure = await call().catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(
          "Le catalogue a renvoyé une réponse illisible. Réessayez dans un instant.",
        );
      }
    });

    it("des copies illisibles valent « aucune copie » et ne bloquent pas la liste", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ items: publicSales, count: 2, mirrors: "oups" }), {
            status: 200,
          }),
        ),
      );

      const items = await fetchSearchResults({ search: {}, preview: true });

      expect(items).toHaveLength(2);
      expect(items[0]!.media![0]).toEqual({ type: "image", url: PHOTO });
    });
  });

  describe("recherche connectée : copies des photos", () => {
    const mirrorRow = {
      source_url: PHOTO,
      path_640: "s/abc-640.webp",
      path_1600: "s/abc-1600.webp",
      width: 1600,
      height: 1200,
    };
    const mirrorCalls = () => rpc.mock.calls.filter(([name]) => name === "sale_photo_mirrors");

    beforeEach(() => {
      vi.stubEnv("NEXT_PUBLIC_PHOTO_MIRROR", "on");
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    it("cherche la photo que la carte affichera, pas media[0]", async () => {
      rpc.mockResolvedValue({ data: [mirrorRow], error: null });
      getSalesForSearch.mockResolvedValue([
        {
          id: "full",
          media: [
            { type: "image", url: "https://www.licitor.com/images/logo.png" },
            { type: "image", url: PHOTO },
          ],
        },
      ]);

      const [sale] = await fetchSearchResults({ search: {}, preview: false });

      expect(mirrorCalls()[0]![1]).toEqual({ p_source_urls: [PHOTO] });
      expect(sale!.media![1]!.mirror?.path640).toBe("s/abc-640.webp");
      expect(sale!.media![0]).not.toHaveProperty("mirror");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("la 1re photo de chaque vente reçoit sa copie, en un seul appel", async () => {
      rpc.mockResolvedValue({ data: [mirrorRow], error: null });
      getSalesForSearch.mockResolvedValue([
        {
          id: "full",
          media: [
            { type: "image", url: PHOTO },
            { type: "image", url: PHOTO_B },
          ],
        },
      ]);

      const [sale] = await fetchSearchResults({ search: {}, preview: false });

      expect(mirrorCalls()).toHaveLength(1);
      expect(mirrorCalls()[0]![1]).toEqual({ p_source_urls: [PHOTO] });
      expect(sale!.media![0]!.mirror?.path1600).toBe("s/abc-1600.webp");
      expect(sale!.media![1]).toEqual({ type: "image", url: PHOTO_B });
    });

    it("withMirrors: false rend les ventes sans attendre ni appeler les copies", async () => {
      getSalesForSearch.mockResolvedValue([{ id: "full", media: [{ type: "image", url: PHOTO }] }]);

      const items = await fetchSearchResults({ search: {}, preview: false, withMirrors: false });

      expect(items.map((sale) => sale.id)).toEqual(["full"]);
      expect(rpc).not.toHaveBeenCalled();
    });

    it("fetchSearchPhotoMirrors : un seul appel pour la page, URL d'origine vers copie", async () => {
      rpc.mockResolvedValue({ data: [mirrorRow], error: null });
      const sales = [
        { id: "a", media: [{ type: "image", url: PHOTO }] },
        { id: "b", media: [{ type: "image", url: PHOTO_B }] },
      ] as never[];

      const mirrors = await fetchSearchPhotoMirrors(sales);

      expect(mirrorCalls()).toHaveLength(1);
      expect(mirrorCalls()[0]![1]).toEqual({ p_source_urls: [PHOTO, PHOTO_B] });
      expect([...mirrors.keys()]).toEqual([PHOTO]);
      expect(mirrors.get(PHOTO)?.path640).toBe("s/abc-640.webp");
    });

    it("fetchSearchPhotoMirrors : table vide en cas de panne, d'interrupteur éteint ou de page vide", async () => {
      rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
      const sales = [{ id: "a", media: [{ type: "image", url: PHOTO }] }] as never[];
      expect((await fetchSearchPhotoMirrors(sales)).size).toBe(0);

      expect((await fetchSearchPhotoMirrors([])).size).toBe(0);

      rpc.mockClear();
      vi.stubEnv("NEXT_PUBLIC_PHOTO_MIRROR", "off");
      expect((await fetchSearchPhotoMirrors(sales)).size).toBe(0);
      expect(rpc).not.toHaveBeenCalled();
    });

    it("interrupteur éteint : aucune fonction appelée, résultats identiques", async () => {
      vi.stubEnv("NEXT_PUBLIC_PHOTO_MIRROR", "off");
      getSalesForSearch.mockResolvedValue([{ id: "full", media: [{ type: "image", url: PHOTO }] }]);

      const items = await fetchSearchResults({ search: {}, preview: false });

      expect(rpc).not.toHaveBeenCalled();
      expect(JSON.stringify(items)).not.toContain("mirror");
    });

    it("fonction en erreur : la recherche reste intacte", async () => {
      rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
      getSalesForSearch.mockResolvedValue([{ id: "full", media: [{ type: "image", url: PHOTO }] }]);

      const items = await fetchSearchResults({ search: {}, preview: false });

      expect(items.map((sale) => sale.id)).toEqual(["full"]);
      expect(JSON.stringify(items)).not.toContain("mirror");
    });
  });

  it("fetches only the requested authenticated page with a real offset", async () => {
    getSalesForSearch.mockResolvedValue([]);

    await fetchSearchResults({
      search: { page: 3, limit: 24, sort: "newest" },
      preview: false,
      discovery: true,
    });

    expect(getSalesForSearch).toHaveBeenCalledWith(expect.any(Object), 24, "date_desc", 48, {
      discovery: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("excludes homepage example sales from authenticated and map results", async () => {
    const example = {
      id: "example-immojudis-nantes-maison",
      source_name: "Dossier de démonstration Immojudis",
    };
    const realSale = { id: "49deebe5-bbba-4c8a-9f4e-237a2edbae94" };
    getSalesForSearch.mockResolvedValue([example, realSale]);
    getSaleMapPoints.mockResolvedValue([realSale, example]);

    await expect(fetchSearchResults({ search: {}, preview: false })).resolves.toEqual([realSale]);
    await expect(fetchSearchMapResults({})).resolves.toEqual([realSale]);
  });
});

describe("advanced filters before pagination", () => {
  it("finds matches beyond the first 100 candidates and shares the scan with the counter", async () => {
    getSales.mockReset();
    const sale = {
      id: "match",
      property_type: "house",
      starting_price_eur: 50000,
      app_surface_m2: 100,
      app_surface_kind: "habitable",
    };
    getSales
      .mockResolvedValueOnce(
        Array.from({ length: 100 }, (_, i) => ({
          ...sale,
          id: String(i),
          starting_price_eur: 500000,
        })),
      )
      .mockResolvedValueOnce([sale]);
    const search = { maxPricePerM2: 1000 };
    const [rows, count] = await Promise.all([
      fetchSearchResults({ search, preview: false }),
      fetchSearchCount({ search, preview: false }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["match"]);
    expect(count).toBe(1);
    expect(getSales).toHaveBeenCalledTimes(2);
    expect(getSales.mock.calls[1][3]).toBe(100);
  });
});

describe("complete scan for advanced filters", () => {
  // A catalogue of `size` sales; `getSales` answers like the database: `limit` rows from `offset`.
  function catalogue(size: number) {
    const rows = Array.from({ length: size }, (_, index) => ({
      id: `sale-${index}`,
      starting_price_eur: 1000 + index,
      app_surface_m2: 50,
    }));
    let inFlight = 0;
    let peak = 0;
    const offsets: number[] = [];
    getSales.mockImplementation(async (_filters, limit: number, _sort, offset: number) => {
      offsets.push(offset);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return rows.slice(offset, offset + limit);
    });
    return { rows, offsets, peak: () => peak };
  }
  const search = { maxPricePerM2: 1_000_000 };

  beforeEach(() => {
    getSales.mockReset();
    getSalesCount.mockReset();
  });

  it.each([0, 1, 99, 100, 101, 1753, 4000, 9999])(
    "returns the %i sales in database order, whatever the count says",
    async (size) => {
      for (const count of [size, Math.max(0, size - 500), size + 900, new Error("down")]) {
        const { rows, peak } = catalogue(size);
        if (count instanceof Error) getSalesCount.mockRejectedValue(count);
        else getSalesCount.mockResolvedValue(count);

        const found = await fetchSearchResults({
          search: { ...search, limit: 100_000 },
          preview: false,
          discovery: size % 2 === 0,
        });

        expect(
          found.map((sale) => sale.id),
          `${size} / ${String(count)}`,
        ).toEqual(rows.map((row) => row.id));
        expect(peak()).toBeLessThanOrEqual(4);
        getSales.mockReset();
      }
    },
  );

  it("counts with the filters and the view of the batches, and shares the scan with the count", async () => {
    const { offsets } = catalogue(350);
    getSalesCount.mockResolvedValue(350);

    const [results, count] = await Promise.all([
      fetchSearchResults({ search: { ...search, limit: 1000 }, preview: false }),
      fetchSearchCount({ search, preview: false }),
    ]);

    expect(results).toHaveLength(350);
    expect(count).toBe(350);
    // Four batches, once: the list and the count share one scan.
    expect([...offsets].sort((a, b) => a - b)).toEqual([0, 100, 200, 300]);
    expect(getSalesCount).toHaveBeenCalledTimes(1);
    expect(getSalesCount).toHaveBeenCalledWith(expect.anything(), { discovery: false });
    expect(getSales).toHaveBeenCalledWith(expect.anything(), 100, expect.anything(), 300, {
      discovery: false,
      completenessTier: true,
    });
  });

  it("still refuses a search of 10 000 sales or more", async () => {
    catalogue(10_000);
    getSalesCount.mockResolvedValue(10_000);

    await expect(fetchSearchResults({ search, preview: false })).rejects.toThrow(
      "Cette recherche est trop large",
    );
  });

  it("passes on the failure of a batch", async () => {
    catalogue(1000);
    getSalesCount.mockResolvedValue(1000);
    getSales.mockImplementation(async (_f, _l, _s, offset: number) => {
      if (offset === 500) throw new Error("lecture impossible");
      return Array.from({ length: 100 }, (_, index) => ({ id: `${offset}-${index}` }));
    });

    await expect(fetchSearchResults({ search, preview: false })).rejects.toThrow(
      "lecture impossible",
    );
  });
});
