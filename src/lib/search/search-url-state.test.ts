import { describe, expect, it } from "vitest";
import {
  MAX_PRICE_EUR,
  canonicalSalesQuery,
  mergeSalesSearch,
  salesSearchToUrlRecord,
  validateSalesSearch,
} from "./search-url-state";

describe("filtre « visite dans les 7 jours » dans l'adresse", () => {
  it("se lit et s'écrit sous visitSoon, et reste absent quand il n'est pas choisi", () => {
    expect(validateSalesSearch({ visitSoon: "true" }).visitSoon).toBe(true);
    expect(validateSalesSearch({}).visitSoon).toBeUndefined();
    expect(salesSearchToUrlRecord({ visitSoon: true }).visitSoon).toBe(true);
    expect(salesSearchToUrlRecord({ visitSoon: false }).visitSoon).toBeUndefined();
  });
});

describe("montants et valeurs ignorées dans l'adresse", () => {
  it("plafonne les montants à 100 000 000 € et les arrondit à l'euro", () => {
    expect(MAX_PRICE_EUR).toBe(100_000_000);
    expect(validateSalesSearch({ maxPrice: "1e30" }).maxPrice).toBe(100_000_000);
    expect(validateSalesSearch({ minPrice: "999999999999" }).minPrice).toBe(100_000_000);
    expect(validateSalesSearch({ maxPricePerM2: "1e12" }).maxPricePerM2).toBe(100_000_000);
    expect(validateSalesSearch({ maxPrice: "150000.6" }).maxPrice).toBe(150_001);
    expect(validateSalesSearch({ maxPrice: "100000000" }).maxPrice).toBe(100_000_000);
  });

  it("n'écrit jamais de notation scientifique dans l'adresse", () => {
    for (const raw of ["1e30", "1e+30", "9e99", "1e21", "123456789012345678901234"]) {
      const record = salesSearchToUrlRecord(validateSalesSearch({ maxPrice: raw, minSqft: raw }));
      for (const value of Object.values(record)) expect(String(value)).not.toMatch(/\de[+-]?\d/i);
    }
  });

  it("ignore une valeur négative ou illisible", () => {
    const search = validateSalesSearch({ minPrice: "-5", maxPrice: "abc", minBeds: "-1" });
    expect(search.minPrice).toBeUndefined();
    expect(search.maxPrice).toBeUndefined();
    expect(search.minBeds).toBeUndefined();
  });
});

describe("canonicalSalesQuery", () => {
  const canonical = (query: string) => canonicalSalesQuery(new URLSearchParams(query))?.toString();

  it("laisse une adresse déjà canonique telle quelle", () => {
    for (const query of [
      "",
      "city=Pau",
      "minPrice=50000&maxPrice=200000",
      "page=2&sort=price_asc",
      "view=table&utm_source=x",
    ]) {
      expect(canonicalSalesQuery(new URLSearchParams(query)), query).toBeNull();
    }
  });

  it("retire une valeur ignorée : minPrice=-5", () => {
    expect(canonical("city=Pau&minPrice=-5")).toBe("city=Pau");
    expect(canonical("minPrice=abc&maxPrice=")).toBe("");
    expect(canonical("page=0")).toBe("");
  });

  it("ramène un montant démesuré au plafond, sans notation scientifique", () => {
    expect(canonical("maxPrice=1e%2B30")).toBe("maxPrice=100000000");
    expect(canonical("maxPrice=1e30&city=Pau")).toBe("city=Pau&maxPrice=100000000");
  });

  it("retire page=1 et normalise l'écriture des entiers", () => {
    expect(canonical("page=1&city=Pau")).toBe("city=Pau");
    expect(canonical("page=02")).toBe("page=2");
    expect(canonical("minBeds=2.0")).toBe("minBeds=2");
  });

  it("garde les paramètres qui ne sont pas des critères numériques", () => {
    expect(canonical("view=table&utm_source=x&minPrice=-1&city=Pau")).toBe(
      "view=table&utm_source=x&city=Pau",
    );
  });

  it("passe un ancien nom de critère à son nom canonique", () => {
    expect(canonical("min_price=50000")).toBe("minPrice=50000");
  });

  it("une fois canonique, l'adresse ne change plus (pas de boucle de réécriture)", () => {
    for (const query of ["minPrice=-5&maxPrice=1e30&page=1&city=Pau", "min_price=1&page=02"]) {
      const first = canonicalSalesQuery(new URLSearchParams(query));
      expect(first).not.toBeNull();
      expect(canonicalSalesQuery(first!)).toBeNull();
    }
  });
});

describe("sales search URL state", () => {
  it("round-trips sale families and resets pagination when the family changes", () => {
    const next = mergeSalesSearch(
      { saleType: "tribunal", page: 4, city: "Bordeaux" },
      { saleType: "notary" },
    );
    expect(next.page).toBeUndefined();
    expect(validateSalesSearch(salesSearchToUrlRecord(next))).toMatchObject({
      saleType: "notary",
      city: "Bordeaux",
    });
    expect(validateSalesSearch({ saleType: "online" }).saleType).toBeUndefined();
    expect(validateSalesSearch({ saleType: "invalid" }).saleType).toBeUndefined();
  });

  it("garde l'ancienne valeur sort=score_desc comme tri explicite par score d'investissement", () => {
    expect(validateSalesSearch({ sort: "score_desc" }).sort).toBe("score_desc");
    expect(salesSearchToUrlRecord({ sort: "score_desc" }).sort).toBe("score_desc");
    expect(validateSalesSearch({ sort: "date_desc" }).sort).toBe("newest");
    expect(validateSalesSearch({ sort: "surface_desc" }).sort).toBe("sqft_desc");
  });

  it("ne met pas le tri par défaut « Mieux renseignées d’abord » dans l'URL", () => {
    expect(salesSearchToUrlRecord({ sort: "relevance" }).sort).toBeUndefined();
    expect(salesSearchToUrlRecord({}).sort).toBeUndefined();
    expect(validateSalesSearch({ sort: "inconnu" }).sort).toBeUndefined();
  });

  it("preserves numeric-looking geographic searches parsed by the router", () => {
    expect(validateSalesSearch({ q: 33000, department: 33 })).toMatchObject({
      query: "33000",
      department: "33",
    });
  });

  it("parses a SeLoger-style base64 bbox as a viewport", () => {
    const search = validateSalesSearch({
      bbox: "LTEuNzU5NDgwMTAyNDU2NzM0Niw0My45NjE1MDg0Mzg5MTY1MjUsMS4yODI2MTcxNTQ0Mzg0MTI0LDQ1LjQzNjcyMzc4NjY3NjEx",
    });

    expect(search.viewport).toEqual({
      east: 1.2826171544384124,
      north: 45.43672378667611,
      south: 43.961508438916525,
      west: -1.7594801024567346,
    });
  });

  it("serializes viewport filters as a shareable bbox", () => {
    const record = salesSearchToUrlRecord({
      viewport: {
        east: 1.2826171544384124,
        north: 45.43672378667611,
        south: 43.961508438916525,
        west: -1.7594801024567346,
      },
    });

    expect(record).toMatchObject({
      bbox: "-1.75948,43.96151,1.28262,45.43672",
    });
    expect(record.viewport).toBeUndefined();
  });
});

describe("filtres « sous la fourchette » et « sans point à vérifier »", () => {
  it("se lisent dans l'adresse et s'y réécrivent à l'identique", () => {
    const search = validateSalesSearch({ belowRange: "true", noPointsToVerify: "1" });
    expect(search.belowRange).toBe(true);
    expect(search.noPointsToVerify).toBe(true);
    expect(salesSearchToUrlRecord(search)).toMatchObject({
      belowRange: true,
      noPointsToVerify: true,
    });
  });

  it("n'écrivent rien quand ils sont éteints ou illisibles", () => {
    for (const raw of [undefined, "false", "0", "peut-être"]) {
      const record = salesSearchToUrlRecord(
        validateSalesSearch({ belowRange: raw, noPointsToVerify: raw }),
      );
      expect(record.belowRange, String(raw)).toBeUndefined();
      expect(record.noPointsToVerify, String(raw)).toBeUndefined();
    }
  });

  it("ne changent pas une adresse canonique qui les porte", () => {
    expect(
      canonicalSalesQuery(new URLSearchParams("belowRange=true&noPointsToVerify=true")),
    ).toBeNull();
  });
});
