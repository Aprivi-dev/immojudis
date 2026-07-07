import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { buildOccupancyAnalysis } from "@/lib/occupation-analysis";

describe("occupation analysis", () => {
  it("qualifies free properties from a structured status and source confirmation", () => {
    const analysis = buildOccupancyAnalysis({
      ...EXAMPLE_SALE,
      occupancy_status: "free",
      source_blocks: {
        occupation: "Libre de toute occupation",
      },
      risks: [],
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "free",
      label: "Libre",
      confidence: "high",
      hasLeaseSignal: false,
    });
    expect(analysis.decisionImpact).toContain("jouissance");
  });

  it("detects lease and tenant signals even when the structured status is unknown", () => {
    const analysis = buildOccupancyAnalysis({
      ...EXAMPLE_SALE,
      occupancy_status: "unknown",
      description: "Appartement loué selon bail d'habitation, loyer mensuel à vérifier.",
      risks: [],
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "rented",
      label: "Loué",
      hasLeaseSignal: true,
    });
    expect(analysis.nextActions).toEqual(
      expect.arrayContaining([
        "Relever bail, loyer, dépôt, impayés, durée restante et clauses de sortie.",
      ]),
    );
  });

  it("flags conflicting occupancy signals before bidding assumptions are fixed", () => {
    const analysis = buildOccupancyAnalysis({
      ...EXAMPLE_SALE,
      occupancy_status: "free",
      description: "Présence d'une personne se déclarant occupante, bail non produit.",
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "conflicting",
      confidence: "low",
      confidenceLabel: "Signaux contradictoires à arbitrer",
    });
    expect(analysis.decisionImpact).toContain("plafond d'enchère");
  });

  it("keeps unknown occupation explicit when only weak source data is present", () => {
    const analysis = buildOccupancyAnalysis({
      ...EXAMPLE_SALE,
      occupancy_status: "unknown",
      description: "Appartement T2 avec balcon.",
      source_description: null,
      llm_display_description: null,
      about_description: null,
      investment_summary: null,
      risk_notes: null,
      source_blocks: null,
      source_blocks_by_source: null,
      score_factors: [],
      documents_rich: [],
      risks: [],
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "to_confirm",
      confidence: "low",
      summary: "À confirmer · 1 indice(s).",
    });
    expect(analysis.limitations[0]).toContain("ne permet pas encore");
  });
});
