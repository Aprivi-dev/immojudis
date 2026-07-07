import { describe, expect, it } from "vitest";
import { buildActiveComparablesAnalysis } from "@/lib/active-comparables-analysis";
import { EXAMPLE_SALE } from "@/lib/example-sale";

const now = new Date("2026-07-06T12:00:00.000Z");

describe("active comparables analysis", () => {
  it("ranks active sales by type, location, surface, price and upcoming audience", () => {
    const analysis = buildActiveComparablesAnalysis({
      sale: EXAMPLE_SALE,
      scopeLabel: "Même ville et même type de bien",
      now,
      candidates: [
        {
          ...EXAMPLE_SALE,
          id: "close-match",
          title: "Appartement T2 comparable",
          starting_price_eur: 95_000,
          app_surface_m2: 44,
          sale_date: "2026-09-20T09:00:00+02:00",
          investment_score: 76,
        },
        {
          ...EXAMPLE_SALE,
          id: "same-department-house",
          title: "Maison éloignée",
          city: "Libourne",
          property_type: "house",
          starting_price_eur: 280_000,
          app_surface_m2: 140,
          investment_score: 52,
        },
      ],
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "matched",
      confidence: "medium",
    });
    expect(analysis.items[0]).toMatchObject({
      id: "close-match",
      matchLabel: "Très comparable",
      pricePerM2: 2159,
    });
    expect(analysis.items[0].matchScore).toBeGreaterThan(analysis.items[1].matchScore);
    expect(analysis.items[0].reasons).toEqual(expect.arrayContaining(["Surface très proche"]));
  });

  it("keeps weak candidates visible without overstating confidence", () => {
    const analysis = buildActiveComparablesAnalysis({
      sale: EXAMPLE_SALE,
      scopeLabel: "Même département",
      now,
      candidates: [
        {
          ...EXAMPLE_SALE,
          id: "weak-candidate",
          city: "Arcachon",
          property_type: "house",
          app_surface_m2: 160,
          starting_price_eur: 350_000,
          sale_date: "2026-11-01T09:00:00+01:00",
        },
      ],
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "candidates_only",
      confidence: "low",
    });
    expect(analysis.items[0].matchLabel).toBe("Éloigné");
    expect(analysis.decisionImpact).toContain("candidats");
  });

  it("marks the feature missing without active candidates", () => {
    const analysis = buildActiveComparablesAnalysis({
      sale: EXAMPLE_SALE,
      candidates: [],
      scopeLabel: "Même ville",
      now,
    });

    expect(analysis).toMatchObject({
      available: false,
      status: "missing",
      confidenceLabel: "Aucun comparable actif exploitable",
      items: [],
    });
    expect(analysis.nextActions[0]).toContain("Élargir");
  });
});
