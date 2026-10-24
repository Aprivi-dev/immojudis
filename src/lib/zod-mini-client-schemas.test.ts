import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adjudicationDistributionSchema } from "@/lib/adjudication-distributions";
import { parseLawyerStatement } from "@/lib/lawyer-statement";
import { emptyPilotDraft, pilotDraftSchema } from "@/lib/professional-pilots";
import { reportRentalScenarioSchema, reportSimulationSchema } from "@/lib/report-simulation";
import { saleProcedureSchema } from "@/lib/sale-procedure";
import { tribunalJudicialActivityQuerySchema } from "@/lib/tribunal-judicial-activity";
import { tribunalJudicialActivityDirectoryQuerySchema } from "@/lib/tribunal-judicial-activity-directory";
import { tribunalListingStatisticsQuerySchema } from "@/lib/tribunal-listing-statistics";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { distributionOf } from "@/test/adjudication-price-directory";

/**
 * Les schémas envoyés au navigateur sont écrits en zod/mini (octobre 2026) : zod complet doublait le
 * bloc client partagé. Ces tests figent les comportements que la réécriture aurait pu changer sans
 * bruit (valeurs par défaut, clés inconnues gardées ou refusées, prétraitements), et vérifient
 * qu'aucun de ces modules ne réimporte zod complet.
 */

const SALE_ID = "7d335032-e935-4550-9347-ed22b0f63449";

describe("modules du navigateur", () => {
  it("n'importent pas zod complet", () => {
    const miniModules = [
      "adjudication-distributions",
      "adjudication-price-statistics",
      "lawyer-statement",
      "professional-pilots",
      "report-simulation",
      "sale-procedure",
      "tribunal-judicial-activity",
      "tribunal-judicial-activity-directory",
      "tribunal-listing-statistics",
    ];
    // Modules dont les schémas de route ont été déplacés : ils n'importent plus zod du tout.
    const zodFreeModules = [
      "favorite-dossier-shared",
      "sale-signal-feedback",
      "information-agent-email-template-token",
    ];
    const source = (name: string) =>
      readFileSync(join(process.cwd(), "src", "lib", `${name}.ts`), "utf8");
    for (const name of miniModules) {
      expect(source(name), name).toMatch(/from "zod\/mini";/);
      expect(source(name), name).not.toMatch(/from "zod";/);
    }
    for (const name of zodFreeModules) {
      expect(source(name), name).not.toMatch(/from "zod(\/mini)?";/);
    }
  });
});

describe("brouillon des pilotes professionnels", () => {
  it("garde toutes les valeurs par défaut, avec des objets neufs à chaque lecture", () => {
    const first = emptyPilotDraft("tribunal");
    expect(first).toEqual({
      schemaVersion: 1,
      kind: "tribunal",
      priceEur: null,
      acquisitionCostsEur: null,
      worksEur: null,
      carryingCostsEur: null,
      exitValueEur: null,
      financingEur: null,
      targetProfitEur: null,
      checkStatuses: {},
      documentStatuses: {},
      documentNotes: {},
      questions: "",
      nextAction: "",
      nextActionAt: null,
      updatedAt: null,
      workspaceRevision: null,
    });
    first.checkStatuses.lot = "verified";
    expect(emptyPilotDraft("tribunal").checkStatuses).toEqual({});
  });

  it("refuse l'infini, un montant hors bornes et un horodatage mal formé", () => {
    const parse = (patch: Record<string, unknown>) =>
      pilotDraftSchema.safeParse({ kind: "notary", ...patch }).success;
    expect(parse({ priceEur: 0, worksEur: 1_000_000_000 })).toBe(true);
    expect(parse({ priceEur: Number.POSITIVE_INFINITY })).toBe(false);
    expect(parse({ priceEur: 1_000_000_001 })).toBe(false);
    expect(parse({ priceEur: -1 })).toBe(false);
    expect(parse({ schemaVersion: 2 })).toBe(false);
    // `updatedAt` : horodatage UTC seulement ; `workspaceRevision` accepte un décalage horaire.
    expect(parse({ updatedAt: "2026-10-24T08:00:00Z" })).toBe(true);
    expect(parse({ updatedAt: "2026-10-24T08:00:00+02:00" })).toBe(false);
    expect(parse({ workspaceRevision: "2026-10-24T08:00:00+02:00" })).toBe(true);
    expect(parse({ questions: "x".repeat(5001) })).toBe(false);
  });
});

describe("procédure de vente", () => {
  const procedure = EXAMPLE_SALE.source_blocks.sale_procedure;

  it("conserve les clés inconnues et complète les valeurs absentes comme avant", () => {
    const parsed = saleProcedureSchema.parse({
      ...procedure,
      state_sale_method: null,
      extra_top: "gardée",
      rules: {
        ...procedure.rules,
        extra_rule: 1,
        guarantee: { ...procedure.rules.guarantee, extra_guarantee: true },
      },
      verification: {
        ...procedure.verification,
        facts: [{ key: "competent_court", status: "verified", extra_fact: "x" }],
      },
    });
    expect(parsed.state_sale_method).toBe("unknown");
    expect(parsed.extra_top).toBe("gardée");
    expect(parsed.rules.extra_rule).toBe(1);
    expect(parsed.rules.guarantee.extra_guarantee).toBe(true);
    expect(parsed.verification.facts[0]).toEqual({
      key: "competent_court",
      status: "verified",
      evidence: [],
      extra_fact: "x",
    });
  });

  it("refuse un délai de paiement non entier ou nul", () => {
    const withDeadline = (days: unknown) =>
      saleProcedureSchema.safeParse({
        ...procedure,
        rules: { ...procedure.rules, payment_deadline_days: days },
      }).success;
    expect(withDeadline(60)).toBe(true);
    expect(withDeadline(null)).toBe(true);
    expect(withDeadline(0)).toBe(false);
    expect(withDeadline(1.5)).toBe(false);
  });
});

describe("scénario du rapport", () => {
  const rental = {
    acquisitionCost: 200_000,
    monthlyRent: 900,
    vacancyRatePct: 5,
    annualNonRecoverableCharges: 0,
    annualPropertyTax: 900,
    annualLandlordInsurance: 150,
    monthlyDebtService: null,
  };

  it("complète la liste des charges manquantes et refuse un coût d'acquisition nul", () => {
    expect(reportRentalScenarioSchema.parse(rental).missingExpenseFields).toEqual([]);
    expect(reportRentalScenarioSchema.safeParse({ ...rental, acquisitionCost: 0 }).success).toBe(
      false,
    );
    expect(reportRentalScenarioSchema.safeParse({ ...rental, vacancyRatePct: 100.5 }).success).toBe(
      false,
    );
  });

  it("retire les clés inconnues et accepte les choix absents ou nuls", () => {
    const parsed = reportSimulationSchema.parse({
      version: 2,
      expectedMaxBid: 100_000,
      extra: "retirée",
      choices: { customMarginPct: null, fpt: undefined, extra: "retirée" },
    });
    expect(parsed).toEqual({
      version: 2,
      expectedMaxBid: 100_000,
      choices: { customMarginPct: null, fpt: undefined },
    });
    expect(
      reportSimulationSchema.safeParse({
        version: 2,
        expectedMaxBid: 100_000,
        choices: { customMarginPct: 51 },
      }).success,
    ).toBe(false);
  });
});

describe("requêtes des statistiques de tribunal", () => {
  it("normalise le code, applique la fenêtre par défaut et refuse les clés inconnues", () => {
    expect(tribunalJudicialActivityQuerySchema.parse({ courtCode: "  TJ-Paris " })).toEqual({
      courtCode: "tj-paris",
      historyMonths: 36,
    });
    expect(tribunalListingStatisticsQuerySchema.parse({ saleId: SALE_ID })).toEqual({
      saleId: SALE_ID,
      historyMonths: 3,
    });
    expect(tribunalJudicialActivityDirectoryQuerySchema.parse({ historyMonths: "12" })).toEqual({
      historyMonths: 12,
    });
    expect(
      tribunalJudicialActivityQuerySchema.safeParse({ courtCode: "paris", extra: "1" }).success,
    ).toBe(false);
    expect(
      tribunalListingStatisticsQuerySchema.safeParse({ courtCode: "-paris" }).error?.issues,
    ).toMatchObject([{ code: "custom", message: "Code tribunal invalide." }]);
    expect(
      tribunalJudicialActivityQuerySchema.safeParse({ courtCode: "paris", saleId: SALE_ID }).error
        ?.issues,
    ).toMatchObject([{ code: "custom", message: "Fournissez exactement courtCode ou saleId." }]);
    expect(
      tribunalJudicialActivityQuerySchema.safeParse({ courtCode: "paris", historyMonths: "6" })
        .success,
    ).toBe(false);
  });
});

describe("répartitions d'adjudication", () => {
  it("refusent une clé inconnue (objets stricts)", () => {
    const distribution = distributionOf([2, 2, 2, 2, 2]);
    expect(adjudicationDistributionSchema.safeParse(distribution).success).toBe(true);
    expect(adjudicationDistributionSchema.safeParse({ ...distribution, extra: 1 }).success).toBe(
      false,
    );
  });
});

describe("relevé des avocats", () => {
  it("convertit les compteurs reçus en texte et lit un cabinet absent comme nul", () => {
    expect(
      parseLawyerStatement("2026-11", [
        {
          lawyer_id: SALE_ID,
          display_name: "Me Exemple",
          impressions: "4",
          cta_clicks: 2,
          referral_requests_sent: "0",
        },
      ]).rows,
    ).toEqual([
      {
        lawyerId: SALE_ID,
        displayName: "Me Exemple",
        firmName: null,
        impressions: 4,
        ctaClicks: 2,
        referralRequestsSent: 0,
      },
    ]);
    expect(() =>
      parseLawyerStatement("2026-11", [
        {
          lawyer_id: SALE_ID,
          display_name: "Me Exemple",
          impressions: "1.5",
          cta_clicks: 0,
          referral_requests_sent: 0,
        },
      ]),
    ).toThrow();
  });
});
