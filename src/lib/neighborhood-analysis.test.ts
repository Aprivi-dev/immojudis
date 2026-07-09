import { describe, expect, it } from "vitest";
import { EXAMPLE_MARKET_ESTIMATE, EXAMPLE_SALE } from "@/lib/example-sale";
import { buildNearbyServicesAnalysis } from "@/lib/nearby-services";
import { buildNeighborhoodAnalysis } from "@/lib/neighborhood-analysis";
import { buildStreetFacadeAnalysis } from "@/lib/street-facade-analysis";

describe("neighborhood analysis", () => {
  it("profiles a neighborhood from market, services, street-level map and source signals", () => {
    const nearbyServices = buildNearbyServicesAnalysis(EXAMPLE_SALE);
    const streetFacade = buildStreetFacadeAnalysis(EXAMPLE_SALE);
    const analysis = buildNeighborhoodAnalysis({
      sale: EXAMPLE_SALE,
      marketEstimate: EXAMPLE_MARKET_ESTIMATE,
      nearbyServices,
      streetFacade,
      environmentalContext: null,
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "profiled",
      confidence: "high",
      marketPositionLabel: "forte · 12 vente(s) · 100 m",
      locationQualityLabel: "Coordonnées exploitables",
    });
    expect(analysis.dimensions).toEqual(
      expect.arrayContaining(["Marché DVF", "Services", "Façade et rue", "Signaux source"]),
    );
    expect(analysis.signals.some((signal) => signal.kind === "market")).toBe(true);
  });

  it("keeps a market-only neighborhood profile explicit", () => {
    const sale = {
      ...EXAMPLE_SALE,
      latitude: null,
      longitude: null,
      address: null,
      postal_code: null,
      city: null,
      department: null,
      title: "Bien test",
      tribunal: null,
      tribunal_name: null,
      description: null,
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
    };
    const analysis = buildNeighborhoodAnalysis({
      sale,
      marketEstimate: EXAMPLE_MARKET_ESTIMATE,
      nearbyServices: buildNearbyServicesAnalysis(sale),
      streetFacade: buildStreetFacadeAnalysis(sale),
      environmentalContext: null,
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "market_only",
      confidence: "medium",
      serviceCoverageLabel: "Services à qualifier",
      locationQualityLabel: "Localisation à géocoder",
    });
    expect(analysis.decisionImpact).toContain("environnement visible");
  });

  it("marks neighborhood analysis as missing without market, location or source signals", () => {
    const sale = {
      ...EXAMPLE_SALE,
      latitude: null,
      longitude: null,
      address: null,
      postal_code: null,
      city: null,
      department: null,
      title: "Bien test",
      tribunal: null,
      tribunal_name: null,
      description: null,
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
    };
    const analysis = buildNeighborhoodAnalysis({
      sale,
      marketEstimate: null,
      nearbyServices: buildNearbyServicesAnalysis(sale),
      streetFacade: buildStreetFacadeAnalysis(sale),
      environmentalContext: null,
    });

    expect(analysis).toMatchObject({
      available: false,
      status: "missing",
      confidence: "low",
      dimensions: [],
      signals: [],
    });
    expect(analysis.limitations[0]).toContain("pas encore recoupé");
  });
});
