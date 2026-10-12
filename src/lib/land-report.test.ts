import { describe, expect, it } from "vitest";
import { buildLandReport } from "./land-report";
import type {
  LandPlanningResult,
  LandRiskFinding,
  LandRisksResult,
  LandRuleEvidence,
  LandRulesResult,
} from "./land-report-types";

const NOW = () => new Date("2026-10-02T12:00:00.000Z");

const planning: LandPlanningResult = {
  locationStatus: "references_matched",
  coordinates: { longitude: 3.28, latitude: 49.84 },
  codeInsee: "02691",
  parcels: [],
  zones: [],
  documents: [],
  constraints: [],
  checks: [
    {
      key: "cadastre.parcels",
      label: "Parcelles cadastrales",
      status: "available",
      scope: "parcel",
      sourceUrl: "https://cadastre.data.gouv.fr/",
      checkedAt: NOW().toISOString(),
    },
  ],
  warnings: [],
  completeCoverage: true,
};

const sourceCheck = (key: string, label: string) => ({
  key,
  label,
  status: "available" as const,
  scope: "parcel" as const,
  sourceUrl: `https://example.test/${key}`,
  checkedAt: NOW().toISOString(),
});

const validFinding: LandRiskFinding = {
  id: "rga-1",
  category: "clay",
  label: "Retrait-gonflement des argiles : moyenne",
  scope: "parcel",
  status: "mapped",
  level: "3",
  description: "Exposition retournée par une source officielle de test.",
  consequences: ["Vérifier l’étude géotechnique."],
  regulatory: false,
  sourceUrl: "https://www.georisques.gouv.fr/api/v2/rga",
  sourceLabel: "RGA",
  checkedAt: NOW().toISOString(),
  sourceUpdatedAt: null,
  vintage: null,
  parcelIds: [],
  distanceM: null,
  precision: "parcelle filtrée",
};

const validRisks: LandRisksResult = {
  findings: [validFinding],
  checks: [sourceCheck("rga", "RGA")],
  warnings: [],
};

const validRule: LandRuleEvidence = {
  id: "rule-1",
  topic: "height",
  title: "Hauteur maximale",
  text: "La hauteur maximale est fixée à vérifier dans le règlement.",
  zoneLabels: ["UCa2"],
  documentId: "doc-1",
  sourceUrl: "https://www.geoportail-urbanisme.gouv.fr/document.pdf",
  page: 12,
  article: "Article UC10",
  conditions: [],
  confidence: "extracted",
};

const validRules: LandRulesResult = {
  rules: [validRule],
  checks: [sourceCheck("gpu.rules", "Règlement écrit")],
  warnings: [],
  completeCoverage: true,
};

const input = {
  address: "17 rue Roland Garros",
  postalCode: "02100",
  city: "Saint-Quentin",
  codeInsee: "02691",
  coordinates: { longitude: 3.28, latitude: 49.84 },
  references: [],
};

describe("land report orchestration", () => {
  it("keeps valid risk findings when the PDF/rules source fails", async () => {
    const report = await buildLandReport(
      input,
      { now: NOW },
      {
        planning: async () => planning,
        risks: async () => validRisks,
        rules: async () => {
          throw new Error("PDF fixture unavailable");
        },
      },
    );

    expect(report.planning).toEqual(planning);
    expect(report.risks).toEqual(validRisks);
    expect(report.risks.findings).toHaveLength(1);
    expect(report.rules.rules).toHaveLength(0);
    expect(report.rules.checks[0]).toMatchObject({ key: "rules", status: "unavailable" });
    expect(report.rules.warnings.join(" ")).toMatch(/lecture du règlement/iu);
    expect(report.risks.warnings.join(" ")).not.toMatch(/absence de risque/iu);
  });

  it("keeps valid PDF/rules results when the risk source fails without inventing no-risk", async () => {
    const report = await buildLandReport(
      input,
      { now: NOW },
      {
        planning: async () => planning,
        risks: async () => {
          throw new Error("Géorisques fixture unavailable");
        },
        rules: async () => validRules,
      },
    );

    expect(report.planning).toEqual(planning);
    expect(report.rules).toEqual(validRules);
    expect(report.risks.findings).toHaveLength(0);
    expect(report.risks.checks[0]).toMatchObject({ key: "risks", status: "unavailable" });
    expect(report.risks.warnings.join(" ")).toMatch(/temporairement indisponible/iu);
    expect(report.risks.checks[0]?.message).toMatch(/Aucune absence de risque/iu);
  });
});
