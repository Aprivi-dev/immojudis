import { describe, expect, it } from "vitest";
import { alertCriteriaSummary, normalizeAlertFrequency } from "./alert-criteria-labels";

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
