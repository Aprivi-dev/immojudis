import { describe, expect, it } from "vitest";
import type { Json } from "@/integrations/supabase/types";
import { createTextPdf } from "../simple-pdf";
import { buildPlanEntitlements } from "./entitlements";
import { REPORT_PDF_HEADINGS, reportToPdfLines } from "./pdf";
import { reportWording } from "./report-wording";
import { reportPdfIdentity } from "./serialization";
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

describe("property report rent source", () => {
  const withRentReference = (reference: unknown) => {
    const report = reportWithRentalScenario();
    const snapshot = report.report_snapshot as {
      analysis: { opportunity: Record<string, unknown> };
    };
    report.report_snapshot = {
      ...snapshot,
      analysis: { opportunity: { ...snapshot.analysis.opportunity, rentReference: reference } },
    } as Json;
    // Without a personal scenario the yield shown is the one built on the reference rent.
    report.ceiling_snapshot = { available: true, maxBid: 80_000 } as Json;
    return reportToPdfLines(report, buildPlanEntitlements("analyse"));
  };

  it("credits the ANIL rent map, with its edition and the source link, next to the yield", () => {
    const lines = withRentReference({
      source: "anil_commune",
      vintage: 2025,
      sourceUpdatedOn: "2025-12-11",
    });
    const yieldIndex = lines.findIndex((line) => line.startsWith("Rendement brut potentiel"));

    expect(yieldIndex).toBeGreaterThan(-1);
    expect(lines[yieldIndex + 1]).toContain(
      "Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin.",
    );
    expect(lines[yieldIndex + 1]).toContain("mise à jour du 11 décembre 2025");
    expect(lines[yieldIndex + 2]).toBe(
      "Source : https://www.data.gouv.fr/datasets/693aa2feed1bf4da603faa49",
    );
  });

  it("does not call a charges-included yield « net »", () => {
    const text = withRentReference({
      source: "anil_commune",
      vintage: 2025,
      sourceUpdatedOn: "2025-12-11",
    }).join("\n");

    expect(text).toContain("Rendement brut potentiel, charges comprises:");
    expect(text).not.toMatch(/Rendement net/);
  });

  it("keeps the usual wording for a report built on the department rent", () => {
    const text = withRentReference(null).join("\n");

    expect(text).toContain("Rendement brut potentiel:");
    expect(text).not.toContain("charges comprises");
  });

  it("adds no credit for a report built on the department rent or an older report", () => {
    expect(withRentReference(null).join("\n")).not.toContain("ANIL");
    expect(withRentReference(undefined).join("\n")).not.toContain("ANIL");
  });
});

describe("property report rental PDF", () => {
  it("names the ceiling section a simulation, as a heading too", () => {
    expect(REPORT_PDF_HEADINGS).toContain("Enchère plafond (simulation)");
    expect(REPORT_PDF_HEADINGS).not.toContain("Enchère plafond");
  });

  it("writes « Offre plafond (simulation) » with the seller mention and the estimated fees for a sale by offers", () => {
    const report = reportWithRentalScenario();
    report.ceiling_snapshot = {
      available: true,
      maxBid: 80_000,
      regime: "notary_online",
      label: "Offre plafond (simulation)",
      scopeNote: "Hors débours et formalités du notaire.",
      reserveNotice:
        "Le vendeur n’est pas tenu de retenir la meilleure offre ; prix de réserve inconnu.",
      estimatedFees: [{ key: "negotiation", label: "Honoraires de négociation", amount: null }],
      steps: [],
    } as Json;
    const lines = reportToPdfLines(report, buildPlanEntitlements("analyse"));

    expect(REPORT_PDF_HEADINGS).toContain("Offre plafond (simulation)");
    expect(lines).toContain("Offre plafond (simulation)");
    expect(lines.some((line) => line.startsWith("Offre plafond (simulation): 80"))).toBe(true);
    expect(lines).toContain("Hors débours et formalités du notaire.");
    expect(lines).toContain(
      "Le vendeur n’est pas tenu de retenir la meilleure offre ; prix de réserve inconnu.",
    );
    expect(lines).toContain("Frais estimés, à confirmer : Honoraires de négociation");
    expect(lines).not.toContain("Enchère plafond (simulation)");
  });

  it("uses the wording of a sale by offers: first offer, no auction, no court fees", () => {
    const report = reportWithRentalScenario();
    const snapshot = report.report_snapshot as { sale: Record<string, unknown> };
    report.report_snapshot = {
      ...snapshot,
      sale: { ...snapshot.sale, startingPrice: 150_000 },
      analysis: {
        opportunity: { acquisitionCosts: { acquisitionFeesTotal: 12_000 } },
      },
    } as Json;
    report.ceiling_snapshot = {
      available: true,
      maxBid: 120_000,
      regime: "notary_online",
      label: "Offre plafond (simulation)",
      estimatedFees: [],
      steps: [],
    } as Json;
    const lines = reportToPdfLines(report, buildPlanEntitlements("analyse"));
    const text = lines.join("\n");

    expect(lines.some((line) => line.startsWith("Première offre possible: 150"))).toBe(true);
    expect(lines).toContain("Frais de l’opération: frais et consignation à confirmer");
    expect(lines).toContain("Coût complet à la première offre possible: à compléter");
    expect(lines).toContain(
      "Plafond inférieur à la première offre possible : ce scénario ne permet pas de faire une offre.",
    );
    expect(text).toContain("honoraires de négociation et frais de publicité selon l’annonce");
    expect(text).not.toMatch(/Mise à prix:|Frais adjudication|avant enchère|d’enchérir/);
    expect(text).not.toMatch(/frais de poursuite|honoraires d’avocat/);
    expect(text).toContain("Relire les pièces officielles avant toute offre.");
  });

  it("names neither the court nor the hearing in a report on a sale by offers", () => {
    const report = reportWithRentalScenario();
    report.ceiling_snapshot = {
      available: true,
      maxBid: 120_000,
      regime: "notary_online",
      label: "Offre plafond (simulation)",
      estimatedFees: [],
      steps: [],
    } as Json;
    const lines = reportToPdfLines(report, buildPlanEntitlements("analyse"));
    expect(lines.some((line) => line.startsWith("Lieu de la vente: "))).toBe(true);
    expect(lines.some((line) => line.startsWith("Préparation de la vente: "))).toBe(true);
    expect(lines.some((line) => line.startsWith("Urgence de la vente: "))).toBe(true);
    expect(lines).toContain("Préparation de la vente");
    expect(lines).not.toContain("Préparation audience");
    expect(lines.some((line) => line.startsWith("Tribunal: "))).toBe(false);
    expect(REPORT_PDF_HEADINGS).toContain("Préparation de la vente");
    expect(REPORT_PDF_HEADINGS).toContain("Actions de préparation de la vente");
    // Footer of the exported PDF: « offre », not « enchère ».
    expect(reportWording("notary_online").footerSentence).toBe(
      "Immojudis - rapport indicatif. Vérifiez les pièces officielles et votre conseil avant toute offre.",
    );
  });

  it("keeps the court wording for a tribunal report and for a report saved before the regimes", () => {
    const before = reportWithRentalScenario();
    before.report_snapshot = {
      ...(before.report_snapshot as Record<string, unknown>),
      analysis: { opportunity: { acquisitionCosts: { acquisitionFeesTotal: 12_000 } } },
    } as Json;
    const lines = reportToPdfLines(before, buildPlanEntitlements("analyse"));
    expect(lines.some((line) => line.startsWith("Mise à prix: "))).toBe(true);
    expect(lines.some((line) => line.startsWith("Frais adjudication: "))).toBe(true);
    expect(lines).toContain("- Relire les pièces officielles avant toute enchère.");
    expect(lines.join("\n")).toContain("frais de poursuite, honoraires d’avocat");
  });

  it("masks the ceiling of a report whose fee regime has been switched off", () => {
    const report = reportWithRentalScenario();
    const snapshot = report.report_snapshot as { analysis: Record<string, unknown> };
    report.report_snapshot = {
      ...snapshot,
      analysis: {
        ...snapshot.analysis,
        opportunity: {
          bidCeiling: { available: true, maxBid: 123_000, marginTotal: 4_000 },
        },
      },
    } as Json;
    report.ceiling_snapshot = {
      available: true,
      maxBid: 123_000,
      targetTotalCost: 150_000,
      regime: "notary_online",
      label: "Offre plafond (simulation)",
      reserveNotice: "Le vendeur n’est pas tenu de retenir la meilleure offre.",
      steps: [{ key: "x", label: "Étape", amount: 1_000, kind: "add" }],
      personalSimulation: { version: 2, monthlyRent: 700 },
    } as Json;
    const plan = buildPlanEntitlements("analyse");

    const open = reportToPdfLines(report, plan, ["tribunal", "notary_online"]).join("\n");
    expect(open).toContain("Offre plafond (simulation): 123");

    const closed = reportToPdfLines(report, plan, ["tribunal"]);
    const text = closed.join("\n");
    expect(closed).toContain(
      "Offre plafond (simulation): indisponible (Plafond momentanément indisponible)",
    );
    expect(text).not.toMatch(/123\s?000|150\s?000/);
    expect(text).not.toContain("Calcul du plafond");
    expect(text).not.toContain("Le vendeur n’est pas tenu");
    expect(text).not.toContain("Scénario personnel sauvegardé");
    // The financing dossier does not carry the amount either.
    expect(
      closed.some((line) => line.startsWith("Offre plafond (simulation): non renseigné")),
    ).toBe(true);
  });

  it("keeps « Enchère plafond (simulation) » for a report saved before the regimes, with no notarial mention", () => {
    const lines = reportToPdfLines(reportWithRentalScenario(), buildPlanEntitlements("analyse"));
    expect(lines).toContain("Enchère plafond (simulation)");
    expect(
      lines.some((line) => /Hors débours|prix de réserve|Frais estimés, à confirmer/.test(line)),
    ).toBe(false);
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
    expect(lines.some((line) => line.includes("Rendement net estimé :"))).toBe(false);
    expect(lines.some((line) => line.includes("Cash-flow mensuel estimé :"))).toBe(false);
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

describe("titre, métadonnées et nom de fichier du PDF", () => {
  const withTitle = (title: string): SavedReportRow => ({
    ...reportWithRentalScenario(),
    id: "12345678-aaaa-bbbb-cccc-1234567890ab",
    title,
  });

  it("expurge le nom d'un particulier du titre et du nom de fichier", () => {
    const { title, filename } = reportPdfIdentity(withTitle("Maison occupée par Pierre Martin"));

    expect(title).toBe("Maison occupée par un occupant");
    expect(filename).toBe("maison-occupee-par-un-occupant-12345678.pdf");
    expect(filename).not.toMatch(/martin|pierre/i);
  });

  it("n'écrit le nom ni sur les pages ni dans /Info /Title", () => {
    const { title } = reportPdfIdentity(withTitle("Maison occupée par Pierre Martin"));
    const bytes = createTextPdf({ title, lines: ["Bien", "Titre: Maison"] });
    const raw = Buffer.from(bytes).toString("latin1");
    // /Info /Title est écrit en UTF-16BE hexadécimal : on compare aussi sous cette forme.
    const hex = (text: string) =>
      Array.from(text, (char) => char.charCodeAt(0).toString(16).padStart(4, "0"))
        .join("")
        .toUpperCase();

    expect(raw).not.toContain("Martin");
    expect(raw.toUpperCase()).not.toContain(hex("Martin"));
    expect(raw.toUpperCase()).toContain(hex("un occupant"));
  });

  it("garde un titre sans nom de personne tel quel", () => {
    const { title, filename } = reportPdfIdentity(withTitle("Appartement Bordeaux 33"));
    expect(title).toBe("Appartement Bordeaux 33");
    expect(filename).toBe("appartement-bordeaux-33-12345678.pdf");
  });
});

describe("mention de la taxe foncière non comptée", () => {
  const lines = (ceiling: Record<string, unknown>) =>
    reportToPdfLines(
      { ...reportWithRentalScenario(), ceiling_snapshot: ceiling as Json },
      buildPlanEntitlements("analyse"),
    );

  it("l'écrit sous le plafond quand la taxe foncière n'est pas renseignée", () => {
    const out = lines({ available: true, maxBid: 120_000, propertyTaxMissing: true });
    const ceilingIndex = out.findIndex((line) => line.startsWith("Enchère plafond (simulation):"));
    expect(ceilingIndex).toBeGreaterThan(-1);
    expect(out.slice(ceilingIndex + 1, ceilingIndex + 3)).toContain("Taxe foncière non comptée");
  });

  it("ne l'écrit pas quand la taxe est renseignée, absente du rapport enregistré ou le plafond indisponible", () => {
    for (const ceiling of [
      { available: true, maxBid: 120_000, propertyTaxMissing: false },
      { available: true, maxBid: 120_000 },
      { available: false, reason: "Aucune enchère rentable", propertyTaxMissing: true },
    ]) {
      expect(lines(ceiling)).not.toContain("Taxe foncière non comptée");
    }
  });
});

describe("rapport au snapshot clairsemé", () => {
  const sparse = (): SavedReportRow => ({
    ...reportWithRentalScenario(),
    report_snapshot: {
      generatedAt: "2026-10-02T10:00:00.000Z",
      sale: { title: "Maison test" },
      analysis: {
        valuationAudit: {},
        audienceReadinessAnalysis: {},
        opportunity: { score: null, apparentDiscountPct: null },
      },
    } as Json,
    ceiling_snapshot: {
      available: true,
      personalSimulation: { version: 2, choices: {} },
      steps: [
        { key: "sans-montant", label: "Étape sans montant", kind: "minus" },
        { key: "montant-nul", label: "Étape à montant nul", amount: null, kind: "add" },
        { key: "reel", label: "Étape réelle", amount: 12_000, kind: "add" },
      ],
      personalRentalScenario: {
        inputs: { vacancyRatePct: 5 },
        result: { monthlyCashFlow: null },
      },
    } as Json,
  });
  const text = () => reportToPdfLines(sparse(), buildPlanEntitlements("analyse")).join("\n");

  it("n'écrit ni null, ni undefined, ni NaN, ni « - 0 € »", () => {
    expect(text()).not.toMatch(/\bnull\b|undefined|NaN|- 0\s€/);
  });

  it("écrit « non renseigné » au lieu d'un score, d'une progression ou d'un montant inventés", () => {
    const out = text();
    expect(out).toContain("Score audit: non renseigné");
    expect(out).toContain("Progression: non renseigné");
    expect(out).toContain("Points prioritaires ouverts: non renseigné");
    expect(out).toContain("Loyer hors charges: non renseigné");
    expect(out).toContain("Taxe foncière: non renseigné");
    expect(out).not.toMatch(/0\/100|\b0 point|Prix non communiqué \/ /);
  });

  it("n'écrit ni la marge de sécurité ni l'étape du plafond sans donnée", () => {
    const out = text();
    expect(out).not.toContain("Marge de sécurité");
    expect(out).not.toContain("Étape sans montant");
    expect(out).not.toContain("Étape à montant nul");
    expect(out).toContain("Étape réelle : + 12");
  });

  it("garde un zéro réel : un score d'audit et un nombre de points à 0 sont des mesures", () => {
    const report = sparse();
    report.report_snapshot = {
      sale: { title: "Maison test" },
      analysis: {
        valuationAudit: { score: 0 },
        audienceReadinessAnalysis: { highPriorityOpenCount: 0, progressPct: 0 },
      },
    } as Json;
    const out = reportToPdfLines(report, buildPlanEntitlements("analyse")).join("\n");
    expect(out).toContain("Score audit: 0/100");
    expect(out).toContain("Points prioritaires ouverts: 0");
    expect(out).toContain("Progression: 0 %");
  });

  it("dit pourquoi la décote manque au lieu d'un tiret", () => {
    const report = sparse();
    report.report_snapshot = {
      sale: { title: "Maison test" },
      analysis: {
        opportunity: {
          apparentDiscountPct: null,
          apparentDiscountNote: "Bien occupé : l’écart n’est pas indiqué.",
        },
      },
    } as Json;
    const lines = reportToPdfLines(report, buildPlanEntitlements("analyse"));
    expect(lines).toContain("Décote apparente: Bien occupé : l’écart n’est pas indiqué.");
  });
});
