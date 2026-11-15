import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { ForbiddenError } from "@/lib/api-errors";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { AuctionSale } from "@/lib/types";

/**
 * Rapport enregistré d'une vente débloquée par un compte Découverte (« le déblocage d'une vente ouvre
 * toute l'offre Analyse sur cette vente ») : ce que le déblocage ouvre, et ce qu'il n'ouvre jamais.
 */

const mocks = vi.hoisted(() => ({
  entitlementVia: vi.fn(),
  resolvePlan: vi.fn(),
  saleForDoor: vi.fn(),
  activeComparables: vi.fn(),
  parcels: vi.fn(),
  dpe: vi.fn(),
  urbanPlanning: vi.fn(),
  backtest: vi.fn(),
  existingReportId: vi.fn(),
  getReport: vi.fn(),
  getReportSaleId: vi.fn(),
  recordPdfExport: vi.fn(),
  upsert: vi.fn(),
  adminUpdate: vi.fn(),
  daily: vi.fn(),
  environment: vi.fn(),
  estimate: vi.fn(),
  visible: vi.fn(),
}));

vi.mock("@/lib/entitlements.server", () => ({
  assertFeatureEntitlementVia: mocks.entitlementVia,
  resolvePlanEntitlements: mocks.resolvePlan,
  getSaleForDoor: mocks.saleForDoor,
}));
vi.mock("@/lib/property-report/repository", () => ({
  getActiveComparableSales: mocks.activeComparables,
  getCadastralParcels: mocks.parcels,
  getDpeDiagnostics: mocks.dpe,
  getUrbanPlanningSignals: mocks.urbanPlanning,
  getValuationBacktestForReport: mocks.backtest,
  getExistingReportId: mocks.existingReportId,
  getReport: mocks.getReport,
  getReportSaleId: mocks.getReportSaleId,
  getSale: vi.fn(),
  recordPdfExport: mocks.recordPdfExport,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      upsert: (row: Record<string, unknown>) => {
        mocks.upsert(row);
        return {
          select: () => ({
            single: async () => ({ data: { id: "report-1", ...row }, error: null }),
          }),
        };
      },
      update: (patch: Record<string, unknown>) => {
        mocks.adminUpdate(patch);
        return { eq: () => ({ eq: () => ({ select: () => ({ single: async () => ({}) }) }) }) };
      },
    }),
  },
}));
vi.mock("@/lib/rate-limit", () => ({ enforceDailyOperationLimits: mocks.daily }));
vi.mock("@/lib/environmental-context", () => ({ getEnvironmentalContext: mocks.environment }));
vi.mock("@/lib/sale-market-estimates", () => ({ getPrecomputedMarketEstimate: mocks.estimate }));
vi.mock("@/lib/rent-reference.server", () => ({ loadSaleRentReference: async () => null }));
vi.mock("@/lib/usage", () => ({ recordFeatureUsageEvent: vi.fn() }));
vi.mock("@/lib/launch-offer.server", () => ({ hasActiveSignupTrial: async () => false }));
vi.mock("@/lib/sale-publication-guard", () => ({ getPublicationVisibleSaleIds: mocks.visible }));

import {
  enablePropertyReportShare,
  exportPropertyReportPdf,
  getPropertyReport,
  listPropertyReports,
  savePropertyReport,
} from "@/lib/property-reports";
import { buildReportSnapshot } from "@/lib/property-report/analysis";
import { buildCeilingSnapshot } from "@/lib/property-report/ceiling-snapshot";
import { buildPlanEntitlements } from "@/lib/property-report/entitlements";
import { reportToPdfLines } from "@/lib/property-report/pdf";
import { reportSourceFingerprint } from "@/lib/property-report/source-integrity";
import { DEFAULT_OPEN_FEE_REGIMES } from "@/lib/fee-regime-open";
import { getSaleProcedure } from "@/lib/sale-procedure";
import type { StructuredUrbanPlanningSignal } from "@/lib/urban-planning-analysis";

const saleId = "11111111-1111-4111-8111-111111111111";
const SOURCE_URL = "https://source-privee.example/annonce/42";
const request = new Request("https://immojudis.com/api/property-reports", { method: "POST" });
const DISCOVERY = buildPlanEntitlements("decouverte");
const ANALYSIS = buildPlanEntitlements("analyse");

/**
 * `sale_procedure` comme l'écrit le pipeline (`_case_sources`, `_facts`) : l'entrée `listing` porte
 * l'URL et le nom de la source, les pièces recopient le nom de la source, les faits et l'horaire
 * recopient l'URL de l'annonce.
 */
const exampleProcedure = (EXAMPLE_SALE.source_blocks as Record<string, unknown>)
  .sale_procedure as Record<string, unknown>;
const exampleVerification = exampleProcedure.verification as Record<string, unknown>;
const pipelineProcedure = {
  ...exampleProcedure,
  rules: {
    ...(exampleProcedure.rules as Record<string, unknown>),
    payment_deadline_source_url: SOURCE_URL,
  },
  sale_session: {
    opens_at: "2026-12-01T10:00:00+01:00",
    closes_at: "2026-12-01T12:00:00+01:00",
    source_url: SOURCE_URL,
  },
  verification: {
    ...exampleVerification,
    case_sources: [
      {
        kind: "listing",
        label: "SOURCE-NOM-PRIVE",
        source_name: "SOURCE-NOM-PRIVE",
        url: SOURCE_URL,
      },
      {
        kind: "document",
        label: "Cahier des conditions de vente",
        source_name: "SOURCE-NOM-PRIVE",
        url: "https://pieces.example/ccv.pdf",
        document_type: "ccv",
      },
      {
        kind: "kind-inconnu",
        label: "Autre",
        source_name: "AUTRE-PRIVE",
        url: "https://autre.example",
      },
      ...(exampleVerification.case_sources as unknown[]).filter(
        (source) => (source as { kind?: string }).kind === "official_reference",
      ),
    ],
    facts: [
      {
        key: "venue_type",
        value: "tribunal",
        status: "verified",
        evidence: [],
        source_url: SOURCE_URL,
      },
    ],
  },
};

/**
 * Une vente portant tout ce que le déblocage n'ouvre pas : `buildReportSnapshot` doit le retirer à
 * nouveau, quelle que soit l'origine de la vente.
 */
const saleWithClosedFields = {
  ...EXAMPLE_SALE,
  id: saleId,
  investment_score: 78,
  score_confidence: 0.9,
  score_factors: [{ key: "price", label: "FACTEUR-SCORE-PRIVE", impact: 12 }],
  risk_notes: "NOTE-RISQUE-INTERNE",
  risks: [{ risk_type: "occupation", risk_label: "RISQUE-PRIVE", evidence: "PREUVE-PRIVEE" }],
  source_name: "SOURCE-NOM-PRIVE",
  primary_source: "SOURCE-NOM-PRIVE",
  source_url: SOURCE_URL,
  source_urls: [SOURCE_URL],
  raw_payload: { brut: "DONNEE-BRUTE" },
  sale_procedure: pipelineProcedure,
  source_blocks: { ...EXAMPLE_SALE.source_blocks, sale_procedure: pipelineProcedure },
} as unknown as AuctionSale;

const auth = {
  userId: "user-1",
  claims: {},
  accountTier: "free",
  userRole: "user",
  isAdmin: false,
  supabase: { from: vi.fn() },
} as unknown as SupabaseAuthContext;

const CLOSED = [
  SOURCE_URL,
  "AUTRE-PRIVE",
  "autre.example",
  "SOURCE-NOM-PRIVE",
  "NOTE-RISQUE-INTERNE",
  "RISQUE-PRIVE",
  "PREUVE-PRIVEE",
  "FACTEUR-SCORE-PRIVE",
  "DONNEE-BRUTE",
];

function expectNothingClosed(value: unknown) {
  const text = JSON.stringify(value);
  for (const marker of CLOSED) expect(text).not.toContain(marker);
}

describe("rapport d'une vente débloquée par un compte Découverte", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.entitlementVia.mockResolvedValue({ plan: DISCOVERY, door: "unlock" });
    mocks.resolvePlan.mockResolvedValue(DISCOVERY);
    mocks.saleForDoor.mockResolvedValue({ sale: saleWithClosedFields, enrichmentKey: SOURCE_URL });
    mocks.activeComparables.mockResolvedValue({ scopeLabel: "Même ville", sales: [] });
    mocks.parcels.mockResolvedValue([]);
    mocks.dpe.mockResolvedValue([]);
    mocks.urbanPlanning.mockResolvedValue([]);
    mocks.backtest.mockResolvedValue(null);
    mocks.existingReportId.mockResolvedValue(null);
    mocks.estimate.mockResolvedValue(null);
    mocks.daily.mockResolvedValue(undefined);
    mocks.environment.mockResolvedValue({ ok: true, error: null, context: null });
    mocks.visible.mockImplementation(async (ids: string[]) => new Set(ids));
  });

  it("asks the unlock of this very sale for the right, then reads the sale through its door", async () => {
    await savePropertyReport({
      auth,
      input: { saleId, reportKind: "opportunity" } as never,
      request,
    });

    expect(mocks.entitlementVia).toHaveBeenCalledWith(
      auth,
      "property.savedReports",
      expect.any(String),
      { saleId },
    );
    expect(mocks.saleForDoor).toHaveBeenCalledWith(auth, saleId, "unlock");
    // Les plafonds journaliers existants s'appliquent tels quels.
    expect(mocks.daily).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "propertyReportCreate", launchOffer: false }),
    );
  });

  it("opens every section of the report, with the enrichments found by the server-side key", async () => {
    await savePropertyReport({
      auth,
      input: { saleId, reportKind: "opportunity", includeEnvironment: true } as never,
      request,
    });

    expect(mocks.parcels).toHaveBeenCalledWith(SOURCE_URL);
    expect(mocks.dpe).toHaveBeenCalledWith(SOURCE_URL);
    expect(mocks.urbanPlanning).toHaveBeenCalledWith(SOURCE_URL);
    expect(mocks.backtest).toHaveBeenCalled();
    // The neighbourhood context is asked for the sale's own place.
    expect(mocks.environment).toHaveBeenCalledWith(
      expect.objectContaining({ lat: saleWithClosedFields.latitude }),
    );
    // Other sales are read in the redacted catalogue view, never their full rows.
    expect(mocks.activeComparables).toHaveBeenCalledWith(
      auth.supabase,
      expect.objectContaining({ id: saleId }),
      "v_auction_sales_discovery",
    );

    const row = mocks.upsert.mock.calls[0][0];
    const snapshot = row.report_snapshot;
    expect(snapshot.door).toBe("unlock");
    expect(snapshot.plan).toBe("decouverte");
    expect(snapshot.analysis.urbanPlanningAnalysis.confidenceLabel).not.toBe(
      "Réservé à l’offre Analyse",
    );
    expect(snapshot.analysis.streetFacadeAnalysis.label).not.toBe("Réservé à l’offre Analyse");
    expect(snapshot.analysis.neighborhoodAnalysis.label).not.toBe("Réservé à l’offre Analyse");
    expect(snapshot.gatedFeatures).toMatchObject({
      valueEstimate: "included",
      soldComparables: "included",
      activeComparables: "included",
      urbanPlanning: "included",
      pdfExport: "included",
      // Ce que le déblocage n'ouvre pas reste fermé.
      dpeExplorer: "locked",
      salesCsvExport: "locked",
    });
  });

  it("stores no score, factor, risk, source name, source url nor raw data", async () => {
    const response = await savePropertyReport({
      auth,
      input: { saleId, reportKind: "opportunity" } as never,
      request,
    });

    const row = mocks.upsert.mock.calls[0][0];
    expect(row.report_snapshot.analysis.opportunity.score).toBeNull();
    expect(row.report_snapshot.analysis.opportunity.scoreConfidencePct).toBeNull();
    expect(row.report_snapshot.analysis.opportunity.scoreFactors).toEqual([]);
    expect(row.report_snapshot.analysis.risks).toEqual([]);
    expect(row.report_snapshot.analysis.sourceName).toBeNull();
    expectNothingClosed(row);
    expectNothingClosed(response);
  });

  it("shows no « 0/mois » quota with the reports of an unlocked sale", async () => {
    const response = await savePropertyReport({
      auth,
      input: { saleId, reportKind: "opportunity" } as never,
      request,
    });

    expect(response.plan.plan).toBe("decouverte");
    expect(response.plan.limits.pdfExportsPerMonth).toBeNull();
    expect(response.plan.limits.propertyReportsPerMonth).toBeNull();
    expect(response.plan.features.pdfExport).toBe("included");
    expect(response.report.plan.limits.pdfExportsPerMonth).toBeNull();
  });

  it("refuses the reports of another sale (no unlock of it)", async () => {
    mocks.entitlementVia.mockRejectedValue(
      new ForbiddenError("Rapports réservés à l’offre Analyse."),
    );

    await expect(
      savePropertyReport({
        auth,
        input: {
          saleId: "22222222-2222-4222-8222-222222222222",
          reportKind: "opportunity",
        } as never,
        request,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(mocks.saleForDoor).not.toHaveBeenCalled();
    expect(mocks.daily).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("stores no urban planning excerpt taken from the raw payload or another source", async () => {
    mocks.urbanPlanning.mockResolvedValue([
      signal({ signalKey: "doc", sourceKind: "pdf", excerpt: "Zone UB du PLU" }),
      signal({
        signalKey: "raw",
        sourceKind: "source_payload",
        sourceName: "Données source",
        excerpt: "EXTRAIT-BRUT-PRIVE",
      }),
    ]);

    await savePropertyReport({
      auth,
      input: { saleId, reportKind: "opportunity" } as never,
      request,
    });

    const text = JSON.stringify(mocks.upsert.mock.calls[0][0]);
    expect(text).toContain("Zone UB du PLU");
    expect(text).not.toContain("EXTRAIT-BRUT-PRIVE");
  });

  describe("a saved report, by its identifier", () => {
    const unlockSnapshot = { door: "unlock", plan: "decouverte", analysis: {} };
    const report = (snapshot: Record<string, unknown>) => ({
      id: "report-1",
      user_id: "user-1",
      sale_id: saleId,
      title: "Rapport",
      report_kind: "opportunity",
      report_snapshot: snapshot,
      ceiling_snapshot: {},
      market_snapshot: null,
      environmental_snapshot: null,
      updated_at: "2026-11-15T10:00:00Z",
      export_count: 0,
    });

    it("finds the report's sale before deciding the right, so that its unlock opens it", async () => {
      mocks.getReportSaleId.mockResolvedValue(saleId);
      mocks.entitlementVia.mockImplementation(async (_auth, _feature, _message, options) => {
        // The sale is found through the lazy lookup, called by the entitlement.
        expect(await options.saleId()).toBe(saleId);
        return { plan: DISCOVERY, door: "unlock" };
      });
      mocks.getReport.mockResolvedValue(report(unlockSnapshot));

      const response = await getPropertyReport({ auth, reportId: "report-1" });

      expect(mocks.getReportSaleId).toHaveBeenCalledWith(auth.supabase, "user-1", "report-1");
      expect(response.report.id).toBe("report-1");
      expect(response.plan.limits.pdfExportsPerMonth).toBeNull();
    });

    it("refuses, through an unlock, a report built with the offer (it carries the score)", async () => {
      mocks.getReport.mockResolvedValue(
        report({ plan: "analyse", analysis: { opportunity: { score: 78 } } }),
      );

      await expect(getPropertyReport({ auth, reportId: "report-1" })).rejects.toMatchObject({
        status: 409,
      });
    });

    it("lists, through an unlock, only the reports built through it", async () => {
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        limit: async () => ({
          data: [
            { ...report(unlockSnapshot), id: "unlock-report" },
            { ...report({ plan: "analyse" }), id: "trial-report" },
          ],
          error: null,
        }),
      };
      const listing = {
        ...auth,
        supabase: { from: () => query },
      } as unknown as SupabaseAuthContext;

      const response = await listPropertyReports({ auth: listing, saleId });

      expect(mocks.entitlementVia).toHaveBeenCalledWith(
        listing,
        "property.savedReports",
        expect.any(String),
        { saleId },
      );
      expect(response.reports.map((item) => item.id)).toEqual(["unlock-report"]);
    });

    it("exports the PDF of the unlocked sale, compared with the sale as the unlock reads it", async () => {
      const builtFrom = { ...saleWithClosedFields, investment_score: null };
      mocks.saleForDoor.mockResolvedValue({ sale: builtFrom, enrichmentKey: SOURCE_URL });
      mocks.getReport.mockResolvedValue(
        report({ ...unlockSnapshot, sourceFingerprint: reportSourceFingerprint(builtFrom) }),
      );

      const pdf = await exportPropertyReportPdf({ auth, reportId: "report-1", request });

      expect(mocks.entitlementVia).toHaveBeenCalledWith(
        auth,
        "property.pdfExport",
        expect.any(String),
        expect.objectContaining({ saleId: expect.any(Function) }),
      );
      expect(mocks.saleForDoor).toHaveBeenCalledWith(auth, saleId, "unlock");
      expect(mocks.daily).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "propertyReportPdf" }),
      );
      expect(pdf.contentType).toBe("application/pdf");
      expect(new TextDecoder().decode(pdf.bytes)).not.toContain(SOURCE_URL);
    });

    it("keeps sharing by link with the subscription: refused through an unlock", async () => {
      mocks.resolvePlan.mockResolvedValue(DISCOVERY);

      await expect(
        enablePropertyReportShare({ auth, reportId: "report-1", origin: "https://immojudis.com" }),
      ).rejects.toThrow("Partage réservé à l’offre Analyse.");
      expect(mocks.entitlementVia).not.toHaveBeenCalled();
      expect(mocks.getReport).not.toHaveBeenCalled();
      expect(mocks.adminUpdate).not.toHaveBeenCalled();
    });

    it("lets the offer share, as before", async () => {
      mocks.resolvePlan.mockResolvedValue(ANALYSIS);
      mocks.getReport.mockRejectedValue(new Error("stop after the right"));

      await expect(
        enablePropertyReportShare({ auth, reportId: "report-1", origin: "https://immojudis.com" }),
      ).rejects.toThrow("stop after the right");
    });
  });
});

function signal(fields: Partial<StructuredUrbanPlanningSignal>): StructuredUrbanPlanningSignal {
  return {
    signalKey: "signal",
    signalKind: "zoning",
    label: "Zonage",
    status: "documented",
    priority: "medium",
    sourceName: "Règlement",
    sourceKind: "document",
    documentUrl: null,
    documentLabel: null,
    documentType: null,
    pageNumber: null,
    excerpt: "Zone",
    action: null,
    confidence: 0.8,
    updatedAt: null,
    ...fields,
  };
}

describe("the listing source inside sale_procedure, through an unlock", () => {
  const snapshot = (door: "plan" | "unlock") =>
    buildReportSnapshot({
      sale: saleWithClosedFields,
      marketEstimate: null,
      activeComparables: { scopeLabel: "", sales: [] },
      cadastreParcels: [],
      dpeDiagnostics: [],
      urbanPlanningSignals: [],
      valuationBacktest: null,
      ceilingSnapshot: buildCeilingSnapshot(
        saleWithClosedFields,
        null,
        {},
        DEFAULT_OPEN_FEE_REGIMES,
        null,
      ),
      plan: door === "plan" ? ANALYSIS : DISCOVERY,
      door,
    });

  it("is in the fixture: the offer's report shows it (the procedure parses)", () => {
    expect(getSaleProcedure(saleWithClosedFields).procedure).not.toBeNull();
    expect(JSON.stringify(snapshot("plan"))).toContain(SOURCE_URL);
  });

  it("never reaches the snapshot nor the PDF of an unlocked sale", () => {
    const built = snapshot("unlock");
    expectNothingClosed(built);
    // The case documents and the official reference stay.
    const text = JSON.stringify(built);
    expect(text).toContain("https://pieces.example/ccv.pdf");
    expect(text).toContain("data.gouv.fr");

    const lines = reportToPdfLines(
      {
        id: "report-1",
        title: "Rapport",
        report_snapshot: built,
        ceiling_snapshot: {},
        updated_at: "2026-11-15T10:00:00Z",
      } as never,
      DISCOVERY,
      DEFAULT_OPEN_FEE_REGIMES,
      "unlock",
    );
    expectNothingClosed(lines);
  });
});
