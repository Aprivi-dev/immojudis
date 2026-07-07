import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { MarketEstimate } from "@/lib/market.functions";
import { buildReportTraceability } from "@/lib/source-traceability";

const MARKET_ESTIMATE: MarketEstimate = {
  source: "DVF Cerema",
  yearsBack: 3,
  areaKind: "urban",
  commune: "Bordeaux",
  medianPricePerM2: 2_000,
  p25PricePerM2: 1_800,
  p75PricePerM2: 2_300,
  minPricePerM2: 1_500,
  maxPricePerM2: 2_800,
  sampleSize: 12,
  parcelSampleSize: 0,
  totalNearbySampleSize: 16,
  outliersRemoved: 1,
  radiusM: 900,
  qualityScore: 76,
  qualityLabel: "correcte",
  qualityWarnings: [],
  comparableMode: "surface_matched",
  surfaceMinM2: 56,
  surfaceMaxM2: 104,
  deviationPct: null,
  addressHistory: [],
  recentTransactions: [],
};

describe("source traceability", () => {
  it("builds a report manifest from listing, documents, risk evidence and market sources", () => {
    const traceability = buildReportTraceability({
      sale: {
        ...EXAMPLE_SALE,
        source_urls: ["/ressources", "https://example.test/vente/demo"],
      },
      marketEstimate: MARKET_ESTIMATE,
      generatedAt: "2026-07-06T10:00:00.000Z",
    });

    expect(traceability.generatedAt).toBe("2026-07-06T10:00:00.000Z");
    expect(traceability.entries.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        "judicial_listing",
        "judicial_document",
        "surface_evidence",
        "risk_evidence",
        "market_estimate",
      ]),
    );
    expect(
      traceability.entries.some((entry) => entry.url === "https://example.test/vente/demo"),
    ).toBe(true);
    expect(traceability.entries.some((entry) => entry.label.includes("PV descriptif"))).toBe(true);
    expect(traceability.limitations.join(" ")).toContain("Aucun rendement");
    expect(traceability.complianceNotice).toContain("sans promesse de gain");
  });

  it("adds explicit limitations when the market estimate or structured evidence is missing", () => {
    const traceability = buildReportTraceability({
      sale: {
        ...EXAMPLE_SALE,
        surface_evidence: null,
        risks: null,
      },
      marketEstimate: null,
      generatedAt: "2026-07-06T10:00:00.000Z",
    });

    expect(traceability.limitations).toEqual(
      expect.arrayContaining([
        "L'estimation marche n'a pas pu etre calculee faute de localisation ou surface exploitable.",
        "La surface retenue n'est pas encore rattachee a une preuve structuree.",
        "Aucun risque structure n'est disponible : la revue des pieces reste indispensable.",
      ]),
    );
  });

  it("tracks structured cadastral parcels as report sources", () => {
    const traceability = buildReportTraceability({
      sale: EXAMPLE_SALE,
      marketEstimate: null,
      cadastreParcels: [
        {
          parcelKey: "33063-AB-0123",
          parcelId: "33063000AB0123",
          codeInsee: "33063",
          department: "33",
          city: "Bordeaux",
          section: "AB",
          parcelNumber: "0123",
          surfaceM2: 480,
          centroidLat: 44.8378,
          centroidLng: -0.5792,
          matchKind: "point_intersection",
          confidence: 0.88,
          sourceApi: "API Carto Cadastre",
        },
      ],
      generatedAt: "2026-07-06T10:00:00.000Z",
    });

    expect(traceability.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "cadastral_context",
          label: "Parcelle cadastrale",
          sourceName: "API Carto Cadastre",
          confidenceLabel: "88%",
        }),
      ]),
    );
  });

  it("tracks ADEME DPE diagnostics as report sources", () => {
    const traceability = buildReportTraceability({
      sale: EXAMPLE_SALE,
      marketEstimate: null,
      dpeDiagnostics: [
        {
          diagnosticNumber: "2133E0178774F",
          dpeClass: "E",
          gesClass: "C",
          establishedAt: "2025-05-10",
          validUntil: "2035-05-09",
          propertyType: "maison",
          address: "10 Rue Exemple 33000 Bordeaux",
          city: "Bordeaux",
          postalCode: "33000",
          inseeCode: "33063",
          department: "33",
          surfaceM2: 82.4,
          energyConsumptionKwhM2Year: 294.2,
          emissionsKgCo2M2Year: 42,
          latitude: 44.8378,
          longitude: -0.5792,
          matchKind: "geo_distance",
          confidence: 0.92,
          sourceApi: "ADEME DPE Open Data",
        },
      ],
      generatedAt: "2026-07-06T10:00:00.000Z",
    });

    expect(traceability.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "dpe_context",
          label: "Diagnostic DPE",
          sourceName: "ADEME DPE Open Data",
          confidenceLabel: "92%",
        }),
      ]),
    );
  });

  it("tracks structured urban planning signals as report sources", () => {
    const traceability = buildReportTraceability({
      sale: EXAMPLE_SALE,
      marketEstimate: null,
      urbanPlanningSignals: [
        {
          signalKey: "servitude_123",
          signalKind: "servitude",
          label: "Servitudes et accès",
          status: "documented",
          priority: "high",
          sourceName: "Cahier des conditions",
          sourceKind: "pdf",
          documentUrl: "/cahier.pdf",
          documentLabel: "Cahier des conditions",
          documentType: "cahier_conditions_vente",
          pageNumber: 8,
          excerpt: "Servitude de passage à qualifier.",
          action: "Qualifier l'impact sur l'accès, l'usage, les travaux et la revente.",
          confidence: 0.91,
          updatedAt: "2026-07-06T10:00:00.000Z",
        },
      ],
      generatedAt: "2026-07-06T10:00:00.000Z",
    });

    expect(traceability.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "urban_planning_context",
          label: "Servitudes et accès",
          sourceName: "Cahier des conditions",
          confidenceLabel: "91%",
        }),
      ]),
    );
  });
});
