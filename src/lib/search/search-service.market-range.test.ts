import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSales: vi.fn(),
  getSalesCount: vi.fn(),
  underRange: vi.fn(),
}));

vi.mock("@/lib/queries", () => ({
  getSales: mocks.getSales,
  getSalesCount: mocks.getSalesCount,
  getSalesForSearch: vi.fn(),
  getSaleMapPoints: vi.fn(),
}));
vi.mock("./market-range-filter", () => ({ fetchUnderRangeSaleIds: mocks.underRange }));

import { fetchSearchCount, fetchSearchMapResults, fetchSearchResults } from "./search-service";

const complete = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  status: "upcoming",
  sale_date: "2099-12-10T09:00:00Z",
  app_surface_m2: 60,
  app_surface_kind: "habitable",
  occupancy_status: "vacant",
  latitude: 44.8,
  longitude: -0.6,
  ...extra,
});

describe("filtres « sous la fourchette » et « sans point à vérifier » : balayage complet", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getSalesCount.mockResolvedValue(4);
    mocks.getSales.mockResolvedValue([
      complete("under"),
      complete("under-no-surface", { app_surface_m2: null }),
      complete("near"),
      complete("under-occupied", { occupancy_status: "occupied" }),
    ]);
    mocks.underRange.mockResolvedValue(new Set(["under", "under-no-surface", "under-occupied"]));
  });

  it("lit la liste des ventes sous la fourchette et ne garde que celles-là, hors biens occupés", async () => {
    const rows = await fetchSearchResults({ search: { belowRange: true }, preview: false });

    expect(rows.map((row) => row.id)).toEqual(["under", "under-no-surface"]);
    expect(mocks.underRange).toHaveBeenCalledTimes(1);
  });

  it("n'appelle pas la liste sans le filtre", async () => {
    await fetchSearchResults({ search: { noPointsToVerify: true }, preview: false });

    expect(mocks.underRange).not.toHaveBeenCalled();
  });

  it("« sans point à vérifier » écarte les ventes qui en laissent un", async () => {
    const rows = await fetchSearchResults({ search: { noPointsToVerify: true }, preview: false });

    expect(rows.map((row) => row.id)).toEqual(["under", "near", "under-occupied"]);
  });

  it("les deux filtres se cumulent, et le total et la carte suivent la même liste", async () => {
    const search = { belowRange: true, noPointsToVerify: true };

    const [rows, count, points] = await Promise.all([
      fetchSearchResults({ search, preview: false }),
      fetchSearchCount({ search, preview: false }),
      fetchSearchMapResults(search),
    ]);

    expect(rows.map((row) => row.id)).toEqual(["under"]);
    expect(count).toBe(1);
    expect(points.map((row) => row.id)).toEqual(["under"]);
  });

  it("compte l'occupation parmi les points seulement pour un compte qui la lit", async () => {
    mocks.getSales.mockResolvedValue([complete("a", { occupancy_status: null })]);
    mocks.getSalesCount.mockResolvedValue(1);
    const search = { noPointsToVerify: true };

    expect(await fetchSearchResults({ search, preview: false, discovery: false })).toHaveLength(0);
    expect(await fetchSearchResults({ search, preview: false, discovery: true })).toHaveLength(1);
  });

  it("échoue au lieu d'afficher toutes les ventes quand la liste n'a pas pu être lue", async () => {
    mocks.underRange.mockRejectedValue(new Error("Le filtre est momentanément indisponible."));

    await expect(
      fetchSearchResults({ search: { belowRange: true }, preview: false }),
    ).rejects.toThrow("momentanément indisponible");
  });
});
