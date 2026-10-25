import { describe, expect, it } from "vitest";
import type { AuctionSale } from "@/lib/types";
import {
  departmentSearchValues,
  matchesFrenchGeoSearch,
  normalizeFrenchSearchText,
  resolveFrenchGeoSearch,
} from "./french-geo-search";

describe("French geographic search", () => {
  it("normalizes accents, apostrophes and separators", () => {
    expect(normalizeFrenchSearchText("  Provence-Alpes-Côte d’Azur ")).toBe(
      "provence alpes cote d azur",
    );
  });

  it("resolves a current region name to all of its departments", () => {
    expect(resolveFrenchGeoSearch("Région Nouvelle-Aquitaine")).toEqual({
      kind: "region",
      departments: ["16", "17", "19", "23", "24", "33", "40", "47", "64", "79", "86", "87"],
    });
  });

  it.each([
    ["Gironde", "33"],
    ["département de la Gironde", "33"],
    ["33", "33"],
    ["Hérault", "34"],
    ["Herault", "34"],
    ["2A", "2A"],
    ["Guadeloupe", "971"],
  ])("resolves department search %s", (query, code) => {
    expect(resolveFrenchGeoSearch(query)).toEqual({
      kind: expect.stringMatching(/department|region/),
      departments: [code],
    });
  });

  it("distinguishes postal codes from department codes", () => {
    expect(resolveFrenchGeoSearch("33000")).toEqual({
      kind: "postal_code",
      postalCode: "33000",
    });
    expect(resolveFrenchGeoSearch("33")).toEqual({ kind: "department", departments: ["33"] });
  });

  it.each([
    ["66, 65, 05", ["66", "65", "05"]],
    ["66 65 05", ["66", "65", "05"]],
    ["66;65", ["66", "65"]],
    ["Gers et Landes", ["32", "40"]],
    ["Seine et Marne, Paris", ["77", "75"]],
    ["33 / Gironde / 2A", ["33", "2A"]],
  ])("resolves the department list %s to each department", (query, departments) => {
    expect(resolveFrenchGeoSearch(query)).toEqual({ kind: "department", departments });
  });

  it.each(["66, Perpignan", "Maisons et appartements", "33 rue", "75 001"])(
    "keeps %s as free text when one element is not a department",
    (query) => {
      expect(resolveFrenchGeoSearch(query).kind).toBe("text");
    },
  );

  it("matches a department list on any of its departments", () => {
    expect(matchesFrenchGeoSearch(sale({ department: "65" }), "66, 65, 05")).toBe(true);
    expect(matchesFrenchGeoSearch(sale({ department: "33" }), "66, 65, 05")).toBe(false);
  });

  it("builds database values for catalogs storing a code or a department name", () => {
    expect(departmentSearchValues(["33", "2A"])).toEqual(["33", "Gironde", "2A", "Corse-du-Sud"]);
  });

  it("keeps a city as free text and matches it without accent sensitivity", () => {
    expect(resolveFrenchGeoSearch("Nimes")).toEqual({ kind: "text", text: "Nimes" });
    expect(matchesFrenchGeoSearch(sale({ city: "Nîmes", postal_code: "30000" }), "Nimes")).toBe(
      true,
    );
  });

  it("matches region, department name, postal code and multi-term city searches", () => {
    const bordeaux = sale({ city: "Bordeaux", department: "33", postal_code: "33000" });
    const bordeauxWithDepartmentName = sale({
      city: "Bordeaux",
      department: "Gironde",
      postal_code: "33000",
    });

    expect(matchesFrenchGeoSearch(bordeaux, "Nouvelle-Aquitaine")).toBe(true);
    expect(matchesFrenchGeoSearch(bordeauxWithDepartmentName, "Nouvelle-Aquitaine")).toBe(true);
    expect(matchesFrenchGeoSearch(bordeaux, "Gironde")).toBe(true);
    expect(matchesFrenchGeoSearch(bordeaux, "33000")).toBe(true);
    expect(matchesFrenchGeoSearch(bordeaux, "Bordeaux 33000")).toBe(true);
    expect(matchesFrenchGeoSearch(bordeaux, "Occitanie")).toBe(false);
  });
});

function sale(overrides: Partial<AuctionSale>): AuctionSale {
  return {
    id: "sale",
    title: "Vente judiciaire",
    source_blocks: null,
    documents_rich: null,
    ...overrides,
  } as AuctionSale;
}
