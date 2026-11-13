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

  // Caractérisation de toutes les régions que la recherche connaît, sigles et outre-mer compris.
  it.each<[string, string[]]>([
    [
      "Auvergne-Rhône-Alpes",
      ["01", "03", "07", "15", "26", "38", "42", "43", "63", "69", "73", "74"],
    ],
    ["ARA", ["01", "03", "07", "15", "26", "38", "42", "43", "63", "69", "73", "74"]],
    ["Bourgogne-Franche-Comté", ["21", "25", "39", "58", "70", "71", "89", "90"]],
    ["BFC", ["21", "25", "39", "58", "70", "71", "89", "90"]],
    ["Bretagne", ["22", "29", "35", "56"]],
    ["Centre-Val de Loire", ["18", "28", "36", "37", "41", "45"]],
    ["Corse", ["2A", "2B"]],
    ["Grand Est", ["08", "10", "51", "52", "54", "55", "57", "67", "68", "88"]],
    ["Hauts-de-France", ["02", "59", "60", "62", "80"]],
    ["Île-de-France", ["75", "77", "78", "91", "92", "93", "94", "95"]],
    ["idf", ["75", "77", "78", "91", "92", "93", "94", "95"]],
    ["Normandie", ["14", "27", "50", "61", "76"]],
    [
      "Nouvelle-Aquitaine",
      ["16", "17", "19", "23", "24", "33", "40", "47", "64", "79", "86", "87"],
    ],
    ["Occitanie", ["09", "11", "12", "30", "31", "32", "34", "46", "48", "65", "66", "81", "82"]],
    ["Pays de la Loire", ["44", "49", "53", "72", "85"]],
    ["Provence-Alpes-Côte d'Azur", ["04", "05", "06", "13", "83", "84"]],
    ["PACA", ["04", "05", "06", "13", "83", "84"]],
    ["Guadeloupe", ["971"]],
    ["région Martinique", ["972"]],
    ["Guyane", ["973"]],
    ["La Réunion", ["974"]],
    ["Réunion", ["974"]],
    ["Mayotte", ["976"]],
  ])("resolves the region %s to its departments", (query, departments) => {
    expect(resolveFrenchGeoSearch(query)).toEqual({ kind: "region", departments });
  });

  it("keeps the overseas group of the department pages out of the regions", () => {
    expect(resolveFrenchGeoSearch("Outre-mer")).toEqual({ kind: "text", text: "Outre-mer" });
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
