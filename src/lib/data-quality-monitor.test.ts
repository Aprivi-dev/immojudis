import { describe, expect, it } from "vitest";
import { buildDataQualityReport } from "@/lib/data-quality-monitor";
import type { AuctionSale } from "@/lib/types";

const NOW = new Date("2026-07-06T08:00:00.000Z");

describe("data quality monitor", () => {
  it("marks product capabilities healthy when sales have the required enrichment", () => {
    const sales = [
      saleFixture({
        id: "sale-1",
        primary_source: "avoventes",
        documents_rich: [
          {
            url: "https://example.test/cahier.pdf",
            label: "Cahier des conditions",
            type: "conditions",
            extraction_status: "completed",
          },
          {
            url: "https://example.test/dpe.pdf",
            label: "Diagnostic DPE",
            type: "diagnostic",
            extraction_status: "completed",
          },
          {
            url: "https://example.test/cadastre.pdf",
            label: "Plan cadastral",
            type: "cadastre",
            extraction_status: "completed",
          },
        ],
        source_blocks: { dpe_classe: "C" },
      }),
      saleFixture({
        id: "sale-2",
        primary_source: "info_encheres",
        city: "Bordeaux",
        department: "33",
        source_blocks: { parcelle: "AB 123", dpe_classe: "D" },
      }),
    ];

    const report = buildDataQualityReport({
      sales,
      runs: [{ status: "succeeded", finished_at: "2026-07-06T06:00:00.000Z" }],
      now: NOW,
    });

    expect(report.overallStatus).toBe("healthy");
    expect(report.freshness).toMatchObject({
      freshnessStatus: "healthy",
      activeSales: 2,
      staleActiveSales: 0,
      hoursSinceLastSuccessfulRun: 2,
    });
    expect(metric(report.capabilities, "opportunity_report")).toMatchObject({
      pct: 100,
      status: "healthy",
    });
    expect(metric(report.fields, "cadastre")).toMatchObject({
      pct: 100,
      status: "healthy",
    });
    expect(metric(report.fields, "ai_description")).toMatchObject({
      pct: 100,
      status: "healthy",
    });
    expect(report.sourceCoverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "avoventes", count: 1, missingAiDescription: 0 }),
        expect.objectContaining({ source: "info_encheres", count: 1 }),
      ]),
    );
  });

  it("surfaces priority gaps when enrichment needed by paid features is missing", () => {
    const report = buildDataQualityReport({
      sales: [
        saleFixture({
          id: "sale-missing",
          latitude: null,
          longitude: null,
          app_surface_m2: null,
          habitable_surface_m2: null,
          carrez_surface_m2: null,
          documents_rich: [],
          documents: null,
          source_blocks: {},
          llm_display_description: null,
          updated_at: "2026-06-01T08:00:00.000Z",
        }),
      ],
      runs: [{ status: "failed", finished_at: "2026-07-01T08:00:00.000Z" }],
      now: NOW,
    });

    expect(report.overallStatus).toBe("critical");
    expect(report.freshness).toMatchObject({
      freshnessStatus: "critical",
      staleActiveSales: 1,
    });
    expect(metric(report.capabilities, "market_estimate")).toMatchObject({
      pct: 0,
      status: "critical",
    });
    expect(report.priorityGaps.map((gap) => gap.key)).toContain("market_estimate");
    expect(report.sourceCoverage[0]).toMatchObject({
      missingLocation: 1,
      missingSurface: 1,
      missingDocuments: 1,
      missingAiDescription: 1,
    });
  });
});

function metric<T extends { key: string }>(items: T[], key: string): T {
  const item = items.find((candidate) => candidate.key === key);
  if (!item) throw new Error(`Metric ${key} missing`);
  return item;
}

function saleFixture(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    id: "sale-1",
    title: "Appartement judiciaire",
    description: null,
    source_description: null,
    llm_display_description:
      "Appartement judiciaire synthétisé automatiquement avec localisation, audience et pièces utiles.",
    about_description: null,
    city: "Lyon",
    department: "69",
    postal_code: "69003",
    address: "10 rue de test",
    tribunal: "TJ Lyon",
    tribunal_code: "tj-lyon",
    tribunal_name: "Tribunal judiciaire de Lyon",
    tribunal_city: "Lyon",
    property_type: "apartment",
    starting_price_eur: 120_000,
    sale_date: "2026-08-20T09:00:00.000Z",
    visit_dates: null,
    lawyer_name: null,
    lawyer_contact: null,
    adjudication_price_eur: null,
    latitude: 45.75,
    longitude: 4.85,
    occupancy_status: "unknown",
    habitable_surface_m2: 72,
    carrez_surface_m2: null,
    land_surface_m2: null,
    app_surface_m2: 72,
    app_surface_kind: "habitable",
    surface_scope: null,
    surface_source: "document",
    surface_confidence: 0.8,
    surface_evidence: "Surface habitable 72 m2",
    rooms_count: 3,
    bedrooms_count: 2,
    bathrooms_count: null,
    parking_count: null,
    has_garden: null,
    has_terrace: null,
    has_garage: null,
    has_pool: null,
    has_air_conditioning: null,
    has_double_glazing: null,
    investment_score: 78,
    investment_summary: null,
    score_version: null,
    score_confidence: null,
    score_factors: null,
    risk_notes: "Parcelle AB 123 mentionnée dans les pièces.",
    source_name: "Avoventes",
    source_url: "https://example.test/vente",
    primary_source: "avoventes",
    source_urls: ["https://example.test/vente"],
    source_blocks: { dpe_classe: "C" },
    source_blocks_by_source: null,
    dedupe_confidence: null,
    quality_flags: null,
    documents: null,
    documents_rich: [
      {
        url: "https://example.test/cahier.pdf",
        label: "Cahier des conditions",
        type: "conditions",
        extraction_status: "completed",
      },
    ],
    media: null,
    risks: [],
    status: "active",
    created_at: "2026-07-01T08:00:00.000Z",
    updated_at: "2026-07-06T07:00:00.000Z",
    ...overrides,
  };
}
