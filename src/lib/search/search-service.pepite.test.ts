import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSales: vi.fn(),
  getSalesCount: vi.fn(),
  pepites: vi.fn(),
}));

vi.mock("@/lib/queries", () => ({
  getSales: mocks.getSales,
  getSalesCount: mocks.getSalesCount,
  getSalesForSearch: vi.fn(),
  getSaleMapPoints: vi.fn(),
}));
vi.mock("./pepite-filter", () => ({ fetchPepiteSaleIds: mocks.pepites }));

import { fetchSearchCount, fetchSearchMapResults, fetchSearchResults } from "./search-service";

const sale = (id: string) => ({
  id,
  status: "upcoming",
  sale_date: "2099-12-10T09:00:00Z",
  latitude: 44.8,
  longitude: -0.6,
});

describe("filtre « Pépites seulement » : balayage complet", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getSalesCount.mockResolvedValue(3);
    mocks.getSales.mockResolvedValue([sale("a"), sale("pepite-1"), sale("c")]);
    mocks.pepites.mockResolvedValue(new Set(["pepite-1"]));
  });

  it("ne garde que les ventes de la liste publique des pépites", async () => {
    const rows = await fetchSearchResults({ search: { pepite: true }, preview: false });
    expect(rows.map((row) => row.id)).toEqual(["pepite-1"]);
    // Une seule lecture de la liste pour toute la recherche.
    expect(mocks.pepites).toHaveBeenCalledTimes(1);
  });

  it("le total et la carte suivent la même liste", async () => {
    const search = { pepite: true };
    const [count, points] = await Promise.all([
      fetchSearchCount({ search, preview: false }),
      fetchSearchMapResults(search),
    ]);
    expect(count).toBe(1);
    expect(points.map((row) => row.id)).toEqual(["pepite-1"]);
  });

  it("sans le filtre, la liste n'est pas lue", async () => {
    await fetchSearchResults({ search: { city: "Pau", noPointsToVerify: true }, preview: false });
    expect(mocks.pepites).not.toHaveBeenCalled();
  });

  it("sans aucune pépite (mode shadow, panne), rend aucune vente sans lire le catalogue", async () => {
    mocks.pepites.mockResolvedValue(new Set());
    const rows = await fetchSearchResults({ search: { pepite: true }, preview: false });
    expect(rows).toEqual([]);
    expect(mocks.getSales).not.toHaveBeenCalled();
  });

  it("une liste illisible (429, 503) fait échouer la recherche au lieu d'afficher toutes les ventes ou aucune", async () => {
    mocks.pepites.mockRejectedValue(
      new Error("Le filtre « Pépites seulement » est momentanément indisponible."),
    );
    await expect(fetchSearchResults({ search: { pepite: true }, preview: false })).rejects.toThrow(
      "momentanément indisponible",
    );
    expect(mocks.getSales).not.toHaveBeenCalled();
  });
});
