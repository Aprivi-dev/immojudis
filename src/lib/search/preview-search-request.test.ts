import { describe, expect, it } from "vitest";
import { buildPreviewSearchArgs, previewSearchRequestKey } from "./preview-search";
import {
  PREVIEW_SEARCH_API_PATH,
  PREVIEW_SEARCH_URL_KEYS,
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

  it("n'envoie que des paramètres que la route accepte", () => {
    const full: SalesSearchParams = {
      city: "Bordeaux",
      department: "33",
      homeTypes: ["house", "apartment"],
      keywords: "garage jardin",
      limit: 12,
      maxPrice: 300_000,
      maxSaleDate: "2026-12-31",
      maxSqft: 200,
      minBaths: 2,
      minBeds: 3,
      minPrice: 50_000,
      minSaleDate: "2026-11-01",
      minSqft: 40,
      page: 3,
      query: "Nîmes centre",
      saleType: "notary",
      sort: "price_desc",
      status: ["upcoming"],
      transactionType: "sold",
      tribunal: "Tribunal judiciaire de Bordeaux",
    };
    const query = previewSearchQueryString(full);
    const names = [...new URLSearchParams(query).keys()];

    // Tous les critères de l'aperçu sont couverts, et rien d'autre n'est envoyé.
    expect(names.sort()).toEqual([...PREVIEW_SEARCH_URL_KEYS].sort());
    expect(parse(query).ok).toBe(true);
  });

  it("envoie des nombres de pièces que la route accepte, même pour une saisie libre", () => {
    expect(previewSearchQueryString({ minBeds: 2.5, minBaths: 30 })).toBe("minBaths=20&minBeds=3");
    expect(previewSearchQueryString({ minBeds: 0 })).toBe("minBeds=0");
    expect(parse(previewSearchQueryString({ minBeds: 2.5, minBaths: 30 })).ok).toBe(true);
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

  it.each([
    "occupancy=libre",
    "minScore=80",
    "bbox=-1,43,1,45",
    "viewport=45:44:2:1",
    "min_price=1",
    "q=Lyon",
    "evil=1",
    "page=1&page=2",
  ])(
    "refuse les critères réservés, les alias, les paramètres inconnus et répétés : %s",
    (query) => {
      expect(parse(query)).toEqual({ ok: false, message: expect.any(String) });
    },
  );

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
    "page=2.7",
    "page=1e2",
    "page=0x10",
    "limit=2.7",
    "limit=1e2",
    "limit=0x10",
    "limit=%2B10",
    "limit=010",
    "minBeds=2.5",
    "minBeds=21",
    "minBaths=21",
    "minBaths=1e1",
    "city=Pa%00u",
    "query=Pau%0A",
    "keywords=garage%09",
    "sort=inconnu",
    "saleType=casino",
    "transactionType=rent",
    "minSaleDate=2026-13-01",
    "maxSaleDate=demain",
    "minSaleDate=2026-12-01&maxSaleDate=2026-11-01",
  ])("%s", (query) => {
    expect(parse(query)).toEqual({ ok: false, message: expect.any(String) });
  });

  it("accepte les entiers stricts en base 10 et les bornes des pièces", () => {
    for (const query of ["page=1", "page=12&limit=100", "minBeds=0", "minBeds=20&minBaths=20"]) {
      expect(parse(query).ok, query).toBe(true);
    }
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
