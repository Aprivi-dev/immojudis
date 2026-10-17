import { describe, expect, it } from "vitest";
import { buildPreviewSearchArgs, previewSearchRequestKey } from "./preview-search";
import {
  PREVIEW_SEARCH_API_PATH,
  parsePreviewSearchRequest,
  previewSearchApiUrl,
  previewSearchLimitViolation,
  previewSearchQueryString,
} from "./preview-search-request";
import type { SalesSearchParams } from "./search-url-state";

const parse = (query: string) => parsePreviewSearchRequest(new URLSearchParams(query));

describe("adresse de la recherche d'aperçu", () => {
  it("est la route nue pour le catalogue sans filtre", () => {
    expect(previewSearchApiUrl({})).toBe(PREVIEW_SEARCH_API_PATH);
  });

  it("ne garde que les critères de l'aperçu public, triés", () => {
    expect(
      previewSearchQueryString({
        sort: "price_asc",
        city: "Bordeaux",
        occupancy: "vacant",
        minScore: 70,
        dpeClasses: ["A", "B"],
        aroundAddress: "12 rue de Paris",
        map: true,
        viewport: { north: 45, south: 44, east: 1, west: 0 },
      }),
    ).toBe("city=Bordeaux&sort=price_asc");
  });

  it("est identique pour une même recherche, quel que soit l'ordre des critères", () => {
    expect(previewSearchQueryString({ city: "Pau", page: 2 })).toBe(
      previewSearchQueryString({ page: 2, city: "Pau" }),
    );
  });
});

describe("la route lit les critères comme la page", () => {
  const searches: SalesSearchParams[] = [
    {},
    { department: "33", minPrice: 50_000, maxPrice: 200_000, sort: "price_asc" },
    { query: "Nouvelle-Aquitaine", page: 2 },
    { query: "33000" },
    { query: "Nîmes centre", keywords: "garage" },
    { homeTypes: ["house", "apartment"], saleType: "notary", page: 4, limit: 12 },
    { minSqft: 80, minBeds: 3, minBaths: 2, maxSqft: 200 },
    { minSaleDate: "2026-09-11", maxSaleDate: "2026-10-01", page: 2 },
    { status: ["upcoming"], tribunal: "Tribunal judiciaire de Bordeaux", city: "Bordeaux" },
    { sort: "beds_desc" },
    { transactionType: "sold" },
  ];

  it.each(searches.map((search) => [JSON.stringify(search), search] as const))(
    "%s : mêmes arguments de la fonction SQL et même clé de requête",
    (_label, search) => {
      const parsed = parse(previewSearchQueryString(search));

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(buildPreviewSearchArgs(parsed.search)).toEqual(buildPreviewSearchArgs(search));
      expect(previewSearchRequestKey(parsed.search)).toBe(previewSearchRequestKey(search));
    },
  );

  it("ignore les critères réservés, les noms d'alias et les paramètres inconnus", () => {
    const parsed = parse(
      "occupancy=libre&minScore=80&bbox=-1,43,1,45&viewport=45:44:2:1&min_price=1&q=Lyon&evil=1",
    );

    expect(parsed).toEqual({ ok: true, search: expect.any(Object) });
    if (!parsed.ok) return;
    expect(buildPreviewSearchArgs(parsed.search)).toEqual(buildPreviewSearchArgs({}));
  });

  it("accepte les valeurs par défaut explicites", () => {
    expect(parse("sort=relevance&page=1&transactionType=for_sale&limit=24").ok).toBe(true);
  });
});

describe("paramètres refusés", () => {
  it.each([
    "page=0",
    "page=1.5x",
    "limit=0",
    "limit=101",
    "page=420&limit=24",
    "minPrice=cher",
    "minBeds=-1",
    "sort=inconnu",
    "saleType=casino",
    "transactionType=rent",
    "minSaleDate=2026-13-01",
    "maxSaleDate=demain",
    "minSaleDate=2026-12-01&maxSaleDate=2026-11-01",
  ])("%s", (query) => {
    expect(parse(query)).toEqual({ ok: false, message: expect.any(String) });
  });

  it("refuse ce que la fonction SQL refuserait (longueurs et nombres de critères)", () => {
    expect(previewSearchLimitViolation({ city: "v".repeat(121) })).not.toBeNull();
    expect(previewSearchLimitViolation({ tribunal: "t".repeat(161) })).not.toBeNull();
    expect(previewSearchLimitViolation({ homeTypes: "abcdefghi".split("") })).not.toBeNull();
    expect(previewSearchLimitViolation({ homeTypes: ["x".repeat(81)] })).not.toBeNull();
    expect(previewSearchLimitViolation({ page: 402, limit: 25 })).not.toBeNull();
  });

  it("accepte la dernière page que la fonction SQL sert (décalage de 10 000)", () => {
    expect(previewSearchLimitViolation({ page: 101, limit: 100 })).toBeNull();
    expect(previewSearchLimitViolation({ page: 102, limit: 100 })).not.toBeNull();
  });
});
