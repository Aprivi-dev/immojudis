import { describe, expect, it } from "vitest";
import { analyseLandProject, buildLandProjectAnalyses } from "./land-project-analysis";
import type {
  LandPlanningResult,
  LandReport,
  LandRuleEvidence,
  LandRulesResult,
  LandRisksResult,
} from "./land-report-types";

const planning: LandPlanningResult = {
  locationStatus: "references_matched",
  coordinates: null,
  codeInsee: "02191",
  parcels: [],
  zones: [
    {
      id: "zone-1",
      label: "UCa2",
      type: "U",
      description: "Zone test",
      documentId: "doc-1",
      documentName: "PLUi",
      parcelIds: ["parcel-1"],
    },
  ],
  documents: [],
  constraints: [],
  checks: [],
  warnings: [],
  completeCoverage: true,
};

const risks: LandRisksResult = { findings: [], checks: [], warnings: [] };

const rule = (topic: LandRuleEvidence["topic"], page: number): LandRuleEvidence => ({
  id: `rule-${topic}-${page}`,
  topic,
  title: topic,
  text: `Règle ${topic} de la zone UCa2, sous réserve des conditions prévues.`,
  zoneLabels: ["UCa2"],
  documentId: "doc-1",
  sourceUrl: "https://data.geopf.fr/annexes/gpu/reglement.pdf",
  page,
  article: "Article UC3",
  conditions: ["sous réserve des conditions prévues"],
  confidence: "extracted",
});

const report = (rules: LandRulesResult): LandReport => ({
  version: "land-report-v1",
  generatedAt: "2026-10-02T12:00:00.000Z",
  planning,
  risks,
  rules,
  projects: [],
});

describe("land project analysis", () => {
  it("starts every project with explicit missing information", () => {
    const result = buildLandProjectAnalyses(
      report({ rules: [], checks: [], warnings: ["PDF partiel"], completeCoverage: false }),
    );

    expect(result).toHaveLength(5);
    expect(result.every((item) => item.status === "insufficient_information")).toBe(true);
    expect(result.every((item) => item.missingInformation.length > 0)).toBe(true);
    expect(result.every((item) => Boolean(item.summary))).toBe(true);
    expect(result.every((item) => item.status !== ("conditions_to_review" as const))).toBe(true);
  });

  it("asks for project parameters instead of calculating an extension right", () => {
    const analysis = analyseLandProject(
      report({ rules: [rule("footprint", 73)], checks: [], warnings: [], completeCoverage: true }),
      { kind: "extension", addedSurfaceM2: 20 },
    );

    expect(analysis.status).toBe("insufficient_information");
    expect(analysis.rules).toHaveLength(1);
    expect(analysis.missingInformation).toEqual(
      expect.arrayContaining(["Emprise au sol existante", "Emprise au sol projetée"]),
    );
    expect(analysis.summary).toMatch(/informations insuffisantes/iu);
  });

  it("returns conditions to review only with complete coverage and supplied parameters", () => {
    const analysis = analyseLandProject(
      report({
        rules: [rule("destination", 73), rule("footprint", 73), rule("height", 77)],
        checks: [],
        warnings: [],
        completeCoverage: true,
      }),
      { kind: "construction", plannedFootprintM2: 90, intendedUse: "habitation" },
    );

    expect(analysis.status).toBe("conditions_to_review");
    expect(analysis.rules.map((item) => item.topic)).toEqual([
      "destination",
      "footprint",
      "height",
    ]);
    expect(analysis.summary).toMatch(/règles documentées/iu);
    expect(analysis.checks.join(" ")).toMatch(/ne vaut ni droit disponible ni autorisation/iu);
  });

  it("keeps an incomplete rules extraction insufficient even when parameters exist", () => {
    const analysis = analyseLandProject(
      report({ rules: [rule("height", 77)], checks: [], warnings: [], completeCoverage: false }),
      { kind: "height", currentHeightM: 6, plannedHeightM: 10, intendedUse: "habitation" },
    );

    expect(analysis.status).toBe("insufficient_information");
    expect(analysis.missingInformation.join(" ")).toMatch(/Couverture du règlement incomplète/iu);
    expect(analysis.checks.join(" ")).toMatch(/Couverture partielle/iu);
  });
});
