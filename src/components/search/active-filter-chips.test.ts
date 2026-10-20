import { describe, expect, it } from "vitest";
import { mergeSalesSearch } from "@/lib/search/search-url-state";
import { WHOLE_FRANCE_PATCH, activeFilterChips, hasGeographicFilter } from "./active-filter-chips";

describe("activeFilterChips", () => {
  it("returns nothing for an unfiltered search, whatever the sort or page", () => {
    expect(activeFilterChips({})).toEqual([]);
    expect(activeFilterChips({ sort: "price_asc", page: 3, limit: 12, map: true })).toEqual([]);
  });

  it("describes each active criterion in French", () => {
    const labels = activeFilterChips({
      city: "Lyon",
      maxPrice: 150_000,
      minSqft: 40,
      homeTypes: ["apartment"],
      dpeClasses: ["A", "B"],
      houseWithLand: true,
    }).map((chip) => chip.label);
    expect(labels).toEqual([
      "Lyon",
      "Appartement",
      "Mise à prix jusqu'à 150 k€",
      "Surface dès 40 m²",
      "DPE A/B",
      "Maison avec terrain",
    ]);
  });

  it("groups a min and a max under one removable chip", () => {
    const chips = activeFilterChips({ minPrice: 50_000, maxPrice: 100_000 });
    expect(chips).toHaveLength(1);
    expect(chips[0].label).toBe("Mise à prix 50 k€ à 100 k€");
    expect(chips[0].clear).toEqual({ minPrice: undefined, maxPrice: undefined });
  });

  it("removes only the chosen criterion", () => {
    const search = { city: "Lyon", maxPrice: 150_000, sort: "price_asc" as const };
    const priceChip = activeFilterChips(search).find((chip) => chip.key === "price")!;
    expect(mergeSalesSearch(search, priceChip.clear)).toMatchObject({
      city: "Lyon",
      sort: "price_asc",
      maxPrice: undefined,
    });
  });

  it("leaves the map-driven search when its chip is removed", () => {
    const chips = activeFilterChips({
      viewport: { north: 46, south: 45, east: 5, west: 4 },
      searchAsMove: true,
    });
    expect(chips.map((chip) => chip.label)).toEqual(["Zone de la carte"]);
    expect(chips[0].clear).toMatchObject({ viewport: undefined, searchAsMove: false });
  });
});

describe("whole-France escape", () => {
  it("only offers itself when the search is limited to a place", () => {
    expect(hasGeographicFilter({ maxPrice: 100_000 })).toBe(false);
    expect(hasGeographicFilter({ department: "69" })).toBe(true);
    expect(hasGeographicFilter({ aroundAddress: "1 rue de la Paix" })).toBe(true);
  });

  it("drops the place and keeps every other criterion", () => {
    const search = { city: "Lyon", department: "69", maxPrice: 100_000, homeTypes: ["house"] };
    expect(mergeSalesSearch(search, WHOLE_FRANCE_PATCH)).toMatchObject({
      city: undefined,
      department: undefined,
      maxPrice: 100_000,
      homeTypes: ["house"],
    });
  });
});

describe("filtres « sous la fourchette » et « sans point à vérifier »", () => {
  it("ont chacun leur puce retirable, qui n'éteint qu'eux", () => {
    const chips = activeFilterChips({ belowRange: true, noPointsToVerify: true, city: "Pau" });
    expect(chips.map((chip) => chip.label)).toEqual([
      "Pau",
      "Mise à prix sous la fourchette des ventes comparables",
      "Sans point à vérifier",
    ]);
    const below = chips.find((chip) => chip.key === "belowRange")!;
    expect(
      mergeSalesSearch({ belowRange: true, noPointsToVerify: true }, below.clear),
    ).toMatchObject({ belowRange: undefined, noPointsToVerify: true });
  });
});
