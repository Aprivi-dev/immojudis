import { describe, expect, it } from "vitest";
import type { Json } from "@/integrations/supabase/types";
import { buildPlanEntitlements } from "./entitlements";
import { REPORT_PDF_HEADINGS, reportToPdfLines } from "./pdf";
import {
  buildReportRentalScenario,
  computeReportRentalScenario,
  type ReportRentalScenarioDraft,
} from "../report-simulation";
import type { SavedReportRow } from "../property-reports";

function reportWithRentalScenario(
  draft: ReportRentalScenarioDraft = {
    monthlyRent: "700",
    vacancyRatePct: "5",
    annualNonRecoverableCharges: "1200",
    annualPropertyTax: "1800",
    annualLandlordInsurance: "240",
  },
): SavedReportRow {
  const inputs = buildReportRentalScenario({
    draft,
    acquisitionCost: 77_720,
    monthlyDebtService: 430,
  });
  if (!inputs) throw new Error("Test scenario should be valid");

  return {
    id: "report-rental",
    user_id: "user-rental",
    sale_id: "sale-rental",
    report_kind: "opportunity",
    title: "Rapport locatif",
    user_notes: null,
    export_count: 0,
    last_exported_at: null,
    report_snapshot: {
      generatedAt: "2026-10-02T10:00:00.000Z",
      sale: {
        title: "Maison test",
        city: "Bordeaux",
        department: "33",
        startingPrice: 92_000,
      },
      analysis: {
        valueEstimate: null,
        opportunity: {
          grossYieldPct: 12,
          score: 70,
          label: "À analyser",
        },
      },
      sourceTraceability: {
        entries: [],
        limitations: [],
        complianceNotice: "Notice test",
      },
    } as Json,
    market_snapshot: {} as Json,
    environmental_snapshot: null,
    ceiling_snapshot: {
      available: true,
      maxBid: 80_000,
      personalRentalScenario: {
        inputs,
        result: computeReportRentalScenario(inputs).result,
      },
    } as Json,
    share_enabled: false,
    share_token: null,
    share_token_hash: null,
    shared_at: null,
    share_expires_at: null,
    share_view_count: 0,
    created_at: "2026-10-02T10:00:00.000Z",
    updated_at: "2026-10-02T10:00:00.000Z",
  };
}

describe("property report rental PDF", () => {
  it("names the ceiling section a simulation, as a heading too", () => {
    expect(REPORT_PDF_HEADINGS).toContain("Enchère plafond (simulation)");
    expect(REPORT_PDF_HEADINGS).not.toContain("Enchère plafond");
  });

  it("prints personal hypotheses and results instead of default rentability metrics", () => {
    const lines = reportToPdfLines(reportWithRentalScenario(), buildPlanEntitlements("analyse"));

    expect(lines).toContain("Scénario locatif personnel");
    expect(lines.some((line) => line.includes("Loyer hors charges: 700"))).toBe(true);
    expect(lines.some((line) => line.includes("Vacance locative: 5 %"))).toBe(true);
    expect(lines.some((line) => line.includes("Charges non récupérables: 1 200"))).toBe(true);
    expect(lines.some((line) => line.includes("Mensualité de financement: 430"))).toBe(true);
    expect(
      lines.some((line) => line.includes("Rendement net d'exploitation du scénario: 6,1 %")),
    ).toBe(true);
    expect(lines.some((line) => line.includes("Cash-flow mensuel avant impôts: -35"))).toBe(true);
    expect(lines.some((line) => line.includes("Rendement brut potentiel:"))).toBe(false);
    expect(lines.some((line) => line.includes("Rendement net estime:"))).toBe(false);
    expect(lines.some((line) => line.includes("Cashflow mensuel estime:"))).toBe(false);
  });

  it("refiltre à la lecture les noms de particuliers d'un rapport enregistré", () => {
    const report = reportWithRentalScenario();
    const snapshot = report.report_snapshot as { sale: Record<string, unknown> };
    const lines = reportToPdfLines(
      {
        ...report,
        title: "Maison occupée par Pierre Martin",
        report_snapshot: {
          ...snapshot,
          sale: {
            ...snapshot.sale,
            title: null,
            description: "Bien appartenant à Monsieur DUPONT Jean-Claude, retraité.",
          },
        } as Json,
      },
      buildPlanEntitlements("analyse"),
    );

    const text = lines.join("\n");
    expect(text).not.toContain("DUPONT");
    expect(text).not.toContain("Martin");
    expect(text).toContain("Maison occupée par un occupant");
  });

  it("prints a starting price of 0 as not communicated, never as 0 €", () => {
    const report = reportWithRentalScenario();
    const snapshot = report.report_snapshot as { sale: Record<string, unknown> };
    const lines = reportToPdfLines(
      {
        ...report,
        report_snapshot: { ...snapshot, sale: { ...snapshot.sale, startingPrice: 0 } } as Json,
      },
      buildPlanEntitlements("analyse"),
    );

    expect(lines).toContain("Mise à prix: Prix non communiqué");
    expect(lines.some((line) => line.startsWith("Mise à prix: 0"))).toBe(false);
  });

  it("identifies blank expense fields while keeping an explicit zero distinguishable", () => {
    const lines = reportToPdfLines(
      reportWithRentalScenario({
        monthlyRent: "700",
        vacancyRatePct: "5",
        annualNonRecoverableCharges: "",
        annualPropertyTax: "",
        annualLandlordInsurance: "0",
      }),
      buildPlanEntitlements("analyse"),
    );

    expect(
      lines.some(
        (line) =>
          line.includes("Postes laissés vides, comptés à 0 €") &&
          line.includes("charges non récupérables") &&
          line.includes("taxe foncière"),
      ),
    ).toBe(true);
    expect(lines.some((line) => line.includes("Assurance propriétaire: 0"))).toBe(true);
  });
});
