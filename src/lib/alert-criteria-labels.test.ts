import { describe, expect, it } from "vitest";
import {
  alertCriteriaSummary,
  alertSalesPath,
  normalizeAlertFrequency,
} from "./alert-criteria-labels";

const base = {
  department: null,
  city: null,
  property_type: null,
  max_price_eur: null,
  min_surface_m2: null,
  occupancy_status: null,
  min_investment_score: null,
  max_price_per_m2: null,
  min_yield_pct: null,
  min_market_discount_pct: null,
  dpe_classes: [],
  require_house_with_land: false,
  advanced_criteria: {},
};

describe("alertCriteriaSummary", () => {
  it("décrit les critères publics en phrases simples", () => {
    const summary = alertCriteriaSummary({
      ...base,
      city: "Bordeaux",
      department: "Gironde",
      property_type: "apartment",
      max_price_eur: 150000,
      min_surface_m2: 40,
      advanced_criteria: { sale_type: "tribunal" },
    });
    expect(summary).toEqual([
      "Lieu : Bordeaux, Gironde",
      "Vente : au tribunal",
      "Bien : Appartement",
      expect.stringMatching(/^Mise à prix maximale : 150\s000\s€$/),
      "Surface minimale : 40 m²",
    ]);
  });

  it("n'invente aucun critère quand l'alerte est ouverte", () => {
    expect(alertCriteriaSummary(base)).toEqual([]);
  });

  it("précise que la décote minimale ne vaut que pour les biens déclarés libres", () => {
    expect(alertCriteriaSummary({ ...base, min_market_discount_pct: 20 })).toEqual([
      "Décote minimale : 20 % (seulement pour les biens déclarés libres)",
    ]);
  });

  it("n'emploie aucun jargon interne", () => {
    const text = alertCriteriaSummary({
      ...base,
      min_investment_score: 60,
      min_yield_pct: 6,
      dpe_classes: ["A", "B"],
      require_house_with_land: true,
    }).join(" ");
    expect(text).not.toMatch(/score|borné|évaluation/i);
    expect(text).toContain("DPE : A, B");
  });
});

describe("normalizeAlertFrequency", () => {
  it("replie « instant » sur quotidienne", () => {
    expect(normalizeAlertFrequency("instant")).toBe("daily");
    expect(normalizeAlertFrequency("daily")).toBe("daily");
    expect(normalizeAlertFrequency("weekly")).toBe("weekly");
  });
});

describe("alertSalesPath", () => {
  it("ramène à /sales sans paramètre quand l'alerte n'a aucun critère", () => {
    expect(alertSalesPath(base)).toBe("/sales");
  });

  it("reprend les critères publics et avancés de l'alerte", () => {
    const url = new URL(
      alertSalesPath({
        ...base,
        department: "33",
        property_type: "house",
        max_price_eur: 200000,
        min_yield_pct: 6,
        dpe_classes: ["D", "E"],
        require_house_with_land: true,
        advanced_criteria: {
          sale_type: "notary",
          min_sale_date: "2026-11-01",
          query: "bordeaux",
          around_address: "Libourne",
          around_radius_km: 15,
          source: "sales_search",
        },
      }),
      "https://immojudis.test",
    );
    expect(url.pathname).toBe("/sales");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      department: "33",
      homeTypes: "house",
      maxPrice: "200000",
      minYield: "6",
      dpe: "D,E",
      houseWithLand: "true",
      saleType: "notary",
      minSaleDate: "2026-11-01",
      query: "bordeaux",
      aroundAddress: "Libourne",
      aroundRadius: "15",
    });
  });

  it("ignore un type de vente inconnu", () => {
    expect(alertSalesPath({ ...base, advanced_criteria: { sale_type: "autre" } })).toBe("/sales");
  });
});

describe("critère « Seulement les pépites »", () => {
  it("se lit dans les critères avancés, en texte", () => {
    expect(
      alertCriteriaSummary({ ...base, city: "Pau", advanced_criteria: { pepite_only: true } }),
    ).toEqual(["Lieu : Pau", "Seulement les pépites"]);
    expect(alertCriteriaSummary({ ...base, advanced_criteria: {} })).toEqual([]);
    expect(alertCriteriaSummary({ ...base, advanced_criteria: { pepite_only: "oui" } })).toEqual(
      [],
    );
  });

  it("revient dans la recherche du catalogue (filtre et adresse de l'alerte)", () => {
    expect(
      alertSalesPath({ ...base, city: "Pau", advanced_criteria: { pepite_only: true } }),
    ).toMatch(/pepite=true/);
    expect(alertSalesPath({ ...base, city: "Pau" })).not.toMatch(/pepite/);
  });
});
