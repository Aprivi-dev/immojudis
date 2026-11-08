import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSalesForCompleteSearch: vi.fn(),
  getSaleRowsByIds: vi.fn(),
  getSalesForSearch: vi.fn(),
  getSaleMapPoints: vi.fn(),
  getSalesCount: vi.fn(),
  pepites: vi.fn(),
}));

vi.mock("@/lib/queries", () => ({
  getSalesForCompleteSearch: mocks.getSalesForCompleteSearch,
  getSaleRowsByIds: mocks.getSaleRowsByIds,
  getSalesCount: mocks.getSalesCount,
  getSalesForSearch: mocks.getSalesForSearch,
  getSaleMapPoints: mocks.getSaleMapPoints,
}));
vi.mock("./pepite-filter", () => ({ fetchPepiteSaleIds: mocks.pepites }));

import { fetchSearchCount, fetchSearchMapResults, fetchSearchResults } from "./search-service";

const sale = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  status: "upcoming",
  sale_date: "2099-12-10T09:00:00Z",
  latitude: 44.8,
  longitude: -0.6,
  ...extra,
});

describe("filtre « Pépites seulement » : liste d'identifiants passée à la base", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.pepites.mockResolvedValue(new Set(["pepite-1", "pepite-2"]));
    mocks.getSalesForSearch.mockResolvedValue([sale("pepite-1")]);
    mocks.getSalesCount.mockResolvedValue(1);
    mocks.getSaleMapPoints.mockResolvedValue([sale("pepite-1")]);
    mocks.getSaleRowsByIds.mockResolvedValue([]);
  });

  it("ne lit que les pépites, avec les autres filtres, le tri et la pagination de la base", async () => {
    const rows = await fetchSearchResults({
      search: { pepite: true, minScore: 60, sort: "score_desc", page: 2, limit: 24 },
      preview: false,
    });

    expect(rows.map((row) => row.id)).toEqual(["pepite-1"]);
    expect(mocks.getSalesForSearch).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ["pepite-1", "pepite-2"], min_score: 60 }),
      24,
      "score_desc",
      24,
      { discovery: false },
    );
    // Plus de balayage de tout le catalogue.
    expect(mocks.getSalesForCompleteSearch).not.toHaveBeenCalled();
  });

  it("le total et la carte lisent la même liste dans la base", async () => {
    const search = { pepite: true, minScore: 60 };
    const [count, points] = await Promise.all([
      fetchSearchCount({ search, preview: false }),
      fetchSearchMapResults(search),
    ]);

    expect(count).toBe(1);
    expect(points.map((row) => row.id)).toEqual(["pepite-1"]);
    expect(mocks.getSalesCount).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ["pepite-1", "pepite-2"], min_score: 60 }),
      { discovery: false },
    );
    expect(mocks.getSaleMapPoints).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ["pepite-1", "pepite-2"] }),
      {},
    );
    expect(mocks.getSalesForCompleteSearch).not.toHaveBeenCalled();
  });

  it("sans le filtre, la liste n'est pas lue", async () => {
    mocks.getSalesForSearch.mockResolvedValue([]);
    await fetchSearchResults({ search: { city: "Pau" }, preview: false });
    expect(mocks.pepites).not.toHaveBeenCalled();
    expect(mocks.getSalesForSearch.mock.calls[0]?.[0]).not.toHaveProperty("ids");
  });

  it("sans aucune pépite (mode shadow, panne), rend aucune vente sans lire le catalogue", async () => {
    mocks.pepites.mockResolvedValue(new Set());
    const search = { pepite: true };

    expect(await fetchSearchResults({ search, preview: false })).toEqual([]);
    expect(await fetchSearchCount({ search, preview: false })).toBe(0);
    expect(await fetchSearchMapResults(search)).toEqual([]);
    expect(mocks.getSalesForSearch).not.toHaveBeenCalled();
    expect(mocks.getSalesCount).not.toHaveBeenCalled();
    expect(mocks.getSaleMapPoints).not.toHaveBeenCalled();
  });

  it("une liste illisible (429, 503) fait échouer la recherche au lieu d'afficher toutes les ventes ou aucune", async () => {
    mocks.pepites.mockRejectedValue(
      new Error("Le filtre « Pépites seulement » est momentanément indisponible."),
    );
    await expect(fetchSearchResults({ search: { pepite: true }, preview: false })).rejects.toThrow(
      "momentanément indisponible",
    );
    expect(mocks.getSalesForSearch).not.toHaveBeenCalled();
  });
});

describe("« Pépites seulement » avec un filtre lu sur les lignes : balayage réduit aux pépites", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.pepites.mockResolvedValue(new Set(["pepite-1"]));
    mocks.getSalesCount.mockResolvedValue(1);
    mocks.getSaleRowsByIds.mockResolvedValue([]);
  });

  it("passe la liste à la base pour la lecture et la recroise avec les lignes", async () => {
    mocks.getSalesForCompleteSearch.mockResolvedValue([
      sale("pepite-1", { starting_price_eur: 50_000, app_surface_m2: 100 }),
      // Une ligne hors liste (base pas encore à jour) reste écartée.
      sale("autre", { starting_price_eur: 50_000, app_surface_m2: 100 }),
    ]);

    const rows = await fetchSearchResults({
      search: { pepite: true, maxPricePerM2: 1000 },
      preview: false,
    });

    expect(rows.map((row) => row.id)).toEqual(["pepite-1"]);
    expect(mocks.getSalesForCompleteSearch.mock.calls[0]?.[0]).toMatchObject({
      ids: ["pepite-1"],
    });
    expect(mocks.getSalesCount.mock.calls[0]?.[0]).toMatchObject({ ids: ["pepite-1"] });
  });

  it("au-delà de 100 pépites, la liste ne voyage plus dans la requête mais filtre toujours", async () => {
    const many = Array.from({ length: 101 }, (_, index) => `pepite-${index}`);
    mocks.pepites.mockResolvedValue(new Set(many));
    mocks.getSalesForCompleteSearch.mockResolvedValue([sale("pepite-3"), sale("autre")]);
    mocks.getSalesCount.mockResolvedValue(2);

    const rows = await fetchSearchResults({ search: { pepite: true }, preview: false });

    expect(rows.map((row) => row.id)).toEqual(["pepite-3"]);
    expect(mocks.getSalesForCompleteSearch.mock.calls[0]?.[0]).not.toHaveProperty("ids");
    expect(mocks.getSalesForSearch).not.toHaveBeenCalled();
  });
});
