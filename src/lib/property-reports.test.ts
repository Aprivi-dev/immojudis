import { describe, expect, it } from "vitest";
import {
  buildOpportunityAnalysis,
  buildPropertyReportShare,
  buildPublicSharedPropertyReport,
  resolvePlanEntitlements,
} from "@/lib/property-reports";
import type { Json } from "@/integrations/supabase/types";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { computeAcquisitionCosts, computeRentabilityScore } from "@/lib/profitability";
import { DEFAULT_OPEN_FEE_REGIMES } from "@/lib/fee-regime-open";
import { buildCeilingSnapshot } from "./property-report/analysis";

const anilReference = {
  rentPerM2: 12,
  source: "anil_commune" as const,
  reliability: "reliable" as const,
  segment: "apt_all" as const,
  communeCode: "33063",
  lowPerM2: 10,
  highPerM2: 14,
  observations: 500,
  vintage: 2025,
  sourceUpdatedOn: "2025-12-11",
};

describe("report rent reference", () => {
  const sale = {
    ...EXAMPLE_SALE,
    department: "23",
    starting_price_eur: 100_000,
    app_surface_m2: 50,
    app_surface_kind: "habitable" as const,
    investment_score: 70,
  };
  const build = (rentReference?: typeof anilReference | null) =>
    buildOpportunityAnalysis({
      sale,
      surfaceM2: 50,
      marketEstimate: null,
      ceilingSnapshot: buildCeilingSnapshot(
        sale,
        null,
        {},
        DEFAULT_OPEN_FEE_REGIMES,
        rentReference ?? null,
      ),
      rentReference,
    });

  it("computes the gross yield with the commune rent and records where the rent comes from", () => {
    const opportunity = build(anilReference);

    // 50 m² x 12 EUR x 12 months over the total cost of a 100 000 EUR sale.
    expect(opportunity.grossYieldPct).toBeCloseTo(6.2, 1);
    expect(opportunity.rentReference).toEqual({
      source: "anil_commune",
      reliability: "reliable",
      rentPerM2: 12,
      vintage: 2025,
      sourceUpdatedOn: "2025-12-11",
    });
    expect(opportunity.rentabilityScore.rentSource).toBe("anil_commune");
  });

  it("gives no yield and no rent source to a property that is not a dwelling", () => {
    const land = { ...sale, department: "33", property_type: "land" };
    const opportunity = buildOpportunityAnalysis({
      sale: land,
      surfaceM2: 50,
      marketEstimate: null,
      ceilingSnapshot: buildCeilingSnapshot(
        land,
        null,
        {},
        DEFAULT_OPEN_FEE_REGIMES,
        anilReference,
      ),
      rentReference: anilReference,
    });

    expect(opportunity.grossYieldPct).toBeNull();
    expect(opportunity.rentReference).toBeNull();
    expect(opportunity.rentabilityScore.available).toBe(false);
    expect(opportunity.rentabilityScore.reason).toBe("Loyer de référence indisponible");
  });

  it("keeps no ANIL source for a department without any rent, and no invented yield", () => {
    const opportunity = build(null);

    expect(opportunity.grossYieldPct).toBeNull();
    expect(opportunity.rentReference).toBeNull();
  });
});

describe("property report sharing", () => {
  it("does not recreate a withdrawn documentary score from financial indicators", () => {
    const sale = { ...EXAMPLE_SALE, investment_score: null, score_confidence: 0.9 };
    const result = buildOpportunityAnalysis({
      sale,
      surfaceM2: 80,
      marketEstimate: null,
      ceilingSnapshot: buildCeilingSnapshot(sale, null, {}, DEFAULT_OPEN_FEE_REGIMES),
    });
    expect(result.score).toBeNull();
    expect(result.scoreConfidencePct).toBeNull();
    expect(result.label).toBe("À compléter");
    expect(result.summary).not.toMatch(/score \d/);
  });
  it("builds a public report without private user notes", () => {
    const report = buildPublicSharedPropertyReport({
      id: "report-1",
      title: "Rapport Bordeaux",
      report_kind: "opportunity",
      report_snapshot: {
        plan: "analyse",
        sale: { city: "Bordeaux", startingPrice: 120000 },
        analysis: { documentsCount: 4 },
        sourceTraceability: {
          entries: [
            {
              id: "source-1",
              kind: "judicial_listing",
              label: "Annonce judiciaire",
              sourceName: "Source test",
              url: "https://example.test/vente",
              capturedAt: "2026-07-06T09:00:00.000Z",
              confidenceLabel: "Source primaire",
              detail: "Fiche source",
              limitation: "A verifier",
            },
          ],
          limitations: ["Limiter l'interpretation aux donnees disponibles."],
          complianceNotice: "Notice test sans promesse de gain.",
        },
      } as Json,
      market_snapshot: { sampleSize: 8 } as Json,
      environmental_snapshot: null,
      ceiling_snapshot: { available: true, maxBid: 98000 } as Json,
      shared_at: "2026-07-06T10:00:00.000Z",
      share_expires_at: null,
      share_view_count: 2,
      updated_at: "2026-07-06T10:00:00.000Z",
    });

    expect(report).toMatchObject({
      id: "report-1",
      title: "Rapport Bordeaux",
      plan: "analyse",
      sale: { city: "Bordeaux", startingPrice: 120000 },
      analysis: { documentsCount: 4 },
      viewCount: 2,
      sourceTrace: [{ label: "Annonce judiciaire", sourceName: "Source test" }],
      limitations: ["Limiter l'interpretation aux donnees disponibles."],
      disclaimer: "Notice test sans promesse de gain.",
    });
    expect(JSON.stringify(report)).not.toContain("user_notes");
  });

  describe("fee regime switch at read time", () => {
    const row = (ceiling: Record<string, unknown>) => ({
      id: "report-regime",
      title: "Rapport vente interactive",
      report_kind: "opportunity" as const,
      report_snapshot: {
        plan: "analyse",
        sale: { city: "Bordeaux", startingPrice: 150000 },
        analysis: {
          opportunity: { bidCeiling: { available: true, maxBid: 120000, marginTotal: 5000 } },
        },
        sourceTraceability: { entries: [], limitations: [], complianceNotice: "Notice" },
      } as Json,
      market_snapshot: {} as Json,
      environmental_snapshot: null,
      ceiling_snapshot: {
        available: true,
        maxBid: 120000,
        regime: "notary_online",
        label: "Offre plafond (simulation)",
        scopeNote: "Hors débours et formalités du notaire.",
        reserveNotice: "Le vendeur n’est pas tenu de retenir la meilleure offre.",
        estimatedFees: [{ key: "negotiation", label: "Honoraires de négociation" }],
        safetyDiscountPct: 8,
        basisLabel: "Médiane locale",
        personalSimulation: { version: 2, choices: { project: "louer" }, expectedMaxBid: 120000 },
        ...ceiling,
      } as Json,
      shared_at: null,
      share_expires_at: null,
      share_view_count: 0,
      updated_at: "2026-10-26T10:00:00.000Z",
    });

    it("keeps the allow-listed notices of an open regime", () => {
      const report = buildPublicSharedPropertyReport(row({}), ["tribunal", "notary_online"]);
      expect(report.ceiling).toMatchObject({
        available: true,
        maxBid: 120000,
        regime: "notary_online",
        label: "Offre plafond (simulation)",
        scopeNote: "Hors débours et formalités du notaire.",
        reserveNotice: "Le vendeur n’est pas tenu de retenir la meilleure offre.",
        estimatedFees: ["Honoraires de négociation"],
      });
      expect(report.analysis).toMatchObject({ opportunity: { bidCeiling: { maxBid: 120000 } } });
    });

    it("makes the ceiling unavailable and hides every amount once its regime is closed", () => {
      const report = buildPublicSharedPropertyReport(row({}), ["tribunal"]);
      expect(report.ceiling).toMatchObject({
        available: false,
        maxBid: null,
        safetyDiscountPct: null,
        reason: "Plafond momentanément indisponible",
        estimatedFees: [],
        scopeNote: null,
        reserveNotice: null,
      });
      expect(report.ceiling.personalSimulation).toBeUndefined();
      expect(report.analysis).toMatchObject({
        opportunity: { bidCeiling: { available: false, maxBid: null, marginTotal: null } },
      });
      expect(JSON.stringify(report)).not.toMatch(/120000|5000,/);
    });

    it("never closes a tribunal report or a report saved before the regimes", () => {
      for (const ceiling of [{ regime: "tribunal" }, { regime: undefined }]) {
        const report = buildPublicSharedPropertyReport(row(ceiling), ["tribunal"]);
        expect(report.ceiling).toMatchObject({ available: true, maxBid: 120000 });
      }
    });

    it("closes by default only a regime without rules", () => {
      const report = buildPublicSharedPropertyReport(row({ regime: "state_auction" }));
      expect(report.ceiling).toMatchObject({ available: false, maxBid: null });
    });
  });

  it("refiltre à la lecture les noms de particuliers d'un rapport figé avant le durcissement du filtre", () => {
    const report = buildPublicSharedPropertyReport({
      id: "report-names",
      title: "Maison occupée par Pierre Martin",
      report_kind: "opportunity",
      report_snapshot: {
        plan: "analyse",
        sale: { city: "Bordeaux", description: "Bien occupé par la famille Martin." },
        analysis: { occupancy: { summary: "Propriété de Paul Dupont" } },
        sourceTraceability: { entries: [], limitations: [], complianceNotice: "Notice" },
      } as Json,
      market_snapshot: {} as Json,
      environmental_snapshot: null,
      ceiling_snapshot: {} as Json,
      shared_at: null,
      share_expires_at: null,
      share_view_count: 0,
      updated_at: "2026-07-06T10:00:00.000Z",
    });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("Martin");
    expect(serialized).not.toContain("Dupont");
    expect(report.title).toBe("Maison occupée par un occupant");
    expect(report.sale).toMatchObject({
      city: "Bordeaux",
      description: "Bien occupé par la famille.",
    });
  });

  it("strips Analyse-only details from public Decouverte shared reports", () => {
    const report = buildPublicSharedPropertyReport({
      id: "report-locked",
      title: "Rapport limité",
      report_kind: "opportunity",
      report_snapshot: {
        plan: "decouverte",
        sale: { city: "Bordeaux", startingPrice: 120000 },
        analysis: {
          documentsCount: 4,
          marketComparablesAnalysis: {
            available: true,
            retainedComparables: ["vente DVF détaillée"],
            addressHistory: ["historique adresse détaillé"],
          },
          valuationBacktest: {
            available: true,
            summary: { interpretation: "backtest avancé" },
          },
          urbanPlanningAnalysis: {
            available: true,
            status: "documented",
            items: ["signal urbanisme"],
            missingChecks: ["contrôle PLU"],
          },
          streetFacadeAnalysis: {
            available: true,
            streetLevelUrl: "https://maps.example.test/street-level",
            summary: "vue façade exploitable",
          },
          neighborhoodAnalysis: {
            available: true,
            summary: "quartier profilé",
            signals: ["signal quartier"],
          },
          activeComparablesAnalysis: {
            available: true,
            summary: "3 biens comparables actifs",
            items: ["bien concurrent"],
          },
        },
        sourceTraceability: {
          entries: [],
          limitations: [],
          complianceNotice: "Notice test.",
        },
      } as Json,
      market_snapshot: { sampleSize: 8 } as Json,
      environmental_snapshot: null,
      ceiling_snapshot: { available: true, maxBid: 98000 } as Json,
      shared_at: "2026-07-06T10:00:00.000Z",
      share_expires_at: null,
      share_view_count: 0,
      updated_at: "2026-07-06T10:00:00.000Z",
    });

    const analysis = report.analysis;
    const marketComparables = record(analysis.marketComparablesAnalysis);
    const urbanPlanning = record(analysis.urbanPlanningAnalysis);
    const streetFacade = record(analysis.streetFacadeAnalysis);
    const neighborhood = record(analysis.neighborhoodAnalysis);
    const activeComparables = record(analysis.activeComparablesAnalysis);

    expect(marketComparables.retainedComparables).toEqual([]);
    expect(marketComparables.addressHistory).toEqual([]);
    expect(analysis.valuationBacktest).toBeNull();
    expect(urbanPlanning).toMatchObject({ available: false, items: [], missingChecks: [] });
    expect(streetFacade).toMatchObject({ available: false, streetLevelUrl: null });
    expect(neighborhood).toMatchObject({ available: false, signals: [] });
    expect(activeComparables).toMatchObject({ available: false, items: [] });
  });

  it("keeps Analyse details in public shared reports", () => {
    const report = buildPublicSharedPropertyReport({
      id: "report-analyse",
      title: "Rapport Analyse",
      report_kind: "opportunity",
      report_snapshot: {
        plan: "analyse",
        sale: { city: "Bordeaux", startingPrice: 120000 },
        analysis: {
          marketComparablesAnalysis: {
            available: true,
            retainedComparables: ["vente DVF détaillée"],
            addressHistory: ["historique adresse détaillé"],
          },
          valuationBacktest: {
            available: true,
            summary: { interpretation: "backtest avancé" },
          },
          urbanPlanningAnalysis: {
            available: true,
            status: "documented",
            items: ["signal urbanisme"],
            missingChecks: ["contrôle PLU"],
          },
          streetFacadeAnalysis: {
            available: true,
            streetLevelUrl: "https://maps.example.test/street-level",
          },
          neighborhoodAnalysis: {
            available: true,
            signals: ["signal quartier"],
          },
          activeComparablesAnalysis: {
            available: true,
            items: ["bien concurrent"],
          },
        },
        sourceTraceability: {
          entries: [],
          limitations: [],
          complianceNotice: "Notice test.",
        },
      } as Json,
      market_snapshot: { sampleSize: 8 } as Json,
      environmental_snapshot: null,
      ceiling_snapshot: { available: true, maxBid: 98000 } as Json,
      shared_at: "2026-07-06T10:00:00.000Z",
      share_expires_at: null,
      share_view_count: 0,
      updated_at: "2026-07-06T10:00:00.000Z",
    });

    const analysis = report.analysis;

    expect(record(analysis.marketComparablesAnalysis).retainedComparables).toEqual([
      "vente DVF détaillée",
    ]);
    expect(record(analysis.marketComparablesAnalysis).addressHistory).toEqual([
      "historique adresse détaillé",
    ]);
    expect(record(analysis.valuationBacktest).available).toBe(true);
    expect(record(analysis.urbanPlanningAnalysis).items).toEqual(["signal urbanisme"]);
    expect(record(analysis.streetFacadeAnalysis).streetLevelUrl).toBe(
      "https://maps.example.test/street-level",
    );
    expect(record(analysis.neighborhoodAnalysis).signals).toEqual(["signal quartier"]);
    expect(record(analysis.activeComparablesAnalysis).items).toEqual(["bien concurrent"]);
  });

  it("ne renvoie au lien public que la liste blanche du plafond, sans les entrées privées", () => {
    const report = buildPublicSharedPropertyReport({
      id: "report-private",
      title: "Rapport locatif",
      report_kind: "opportunity",
      report_snapshot: {
        plan: "analyse",
        sale: {},
        analysis: {},
        sourceTraceability: { entries: [], limitations: [], complianceNotice: "Notice." },
      } as Json,
      market_snapshot: { sampleSize: 8, secretMarketField: "marche-prive" } as Json,
      environmental_snapshot: { secretEnvironmentField: "env-prive" } as Json,
      ceiling_snapshot: {
        available: true,
        maxBid: 98000,
        safetyDiscountPct: 8,
        basisLabel: "Médiane locale",
        targetTotalCost: 123456,
        steps: [{ key: "x", label: "étape interne", amount: 1, kind: "cost" }],
        personalRentalScenario: {
          inputs: { monthlyRent: 1234, monthlyDebtService: 987, annualPropertyTax: 777 },
          result: { monthlyCashFlow: 55 },
        },
        personalSimulation: {
          version: 2,
          expectedMaxBid: 98000,
          choices: {
            project: "louer",
            profile: "prudent",
            works: { key: "devis", amount: 31000, months: 4 },
            fpt: 5000,
            monthlyRent: 1234,
            monthlyCharges: 321,
            annualPropertyTax: 777,
            financingRatePct: 3.4,
          },
          rentalScenario: {
            acquisitionCost: 143000,
            monthlyRent: 1234,
            vacancyRatePct: 5,
            annualNonRecoverableCharges: 0,
            annualPropertyTax: 777,
            annualLandlordInsurance: 0,
            monthlyDebtService: 987,
            missingExpenseFields: [],
          },
        },
      } as Json,
      shared_at: null,
      share_expires_at: null,
      share_view_count: 0,
      updated_at: "2026-07-06T10:00:00.000Z",
    });

    expect(report).not.toHaveProperty("market");
    expect(report).not.toHaveProperty("environmental");
    expect(report.ceiling).toEqual({
      available: true,
      // Snapshot saved before the fee regimes: no wording of its own (the page keeps the default).
      label: null,
      regime: null,
      scopeNote: null,
      reserveNotice: null,
      estimatedFees: [],
      reason: null,
      maxBid: 98000,
      safetyDiscountPct: 8,
      basisLabel: "Médiane locale",
      personalSimulation: {
        version: 2,
        expectedMaxBid: 98000,
        choices: expect.objectContaining({
          project: "louer",
          profile: "prudent",
          works: { key: "devis", amount: 31000 },
          fpt: 5000,
        }),
      },
    });
    const serialized = JSON.stringify(report);
    for (const secret of [
      "1234",
      "987",
      "777",
      "321",
      "financingRatePct",
      "rentalScenario",
      "personalRentalScenario",
      "marche-prive",
      "env-prive",
      "123456",
      "étape interne",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("expose au lien public le terme, le régime, les mentions et les libellés des frais, jamais leurs montants", () => {
    const report = buildPublicSharedPropertyReport({
      id: "report-offer",
      title: "Rapport vente interactive",
      report_kind: "opportunity",
      report_snapshot: {} as Json,
      market_snapshot: {} as Json,
      environmental_snapshot: null,
      ceiling_snapshot: {
        available: true,
        maxBid: 90_000,
        label: "Offre plafond (simulation)",
        regime: "notary_online",
        reserveNotice: "Le vendeur n’est pas tenu de retenir la meilleure offre.",
        scopeNote: "Hors débours et formalités du notaire.",
        estimatedFees: [{ key: "negotiation", label: "Honoraires de négociation", amount: 1234 }],
      } as Json,
      shared_at: null,
      share_expires_at: null,
      share_view_count: 0,
      updated_at: "2026-07-06T10:00:00.000Z",
    });
    expect(report.ceiling).toMatchObject({
      label: "Offre plafond (simulation)",
      regime: "notary_online",
      reserveNotice: "Le vendeur n’est pas tenu de retenir la meilleure offre.",
      scopeNote: "Hors débours et formalités du notaire.",
      estimatedFees: ["Honoraires de négociation"],
    });
    expect(JSON.stringify(report)).not.toContain("1234");
  });

  it("garde un plafond public sûr quand le snapshot est vide ou illisible", () => {
    const report = buildPublicSharedPropertyReport({
      id: "report-empty",
      title: "Rapport vide",
      report_kind: "opportunity",
      report_snapshot: {} as Json,
      market_snapshot: {} as Json,
      environmental_snapshot: null,
      ceiling_snapshot: { personalSimulation: { monthlyRent: 1234 } } as Json,
      shared_at: null,
      share_expires_at: null,
      share_view_count: 0,
      updated_at: "2026-07-06T10:00:00.000Z",
    });
    expect(report.ceiling).toEqual({
      available: false,
      label: null,
      regime: null,
      scopeNote: null,
      reserveNotice: null,
      estimatedFees: [],
      reason: null,
      maxBid: null,
      safetyDiscountPct: null,
      basisLabel: null,
    });
  });

  it("creates a page URL only for active non-expired share links", () => {
    const active = buildPropertyReportShare(
      {
        share_enabled: true,
        share_token: "abcDEF123_-abcDEF123_-abcDEF123",
        shared_at: "2026-07-06T10:00:00.000Z",
        share_expires_at: null,
        share_view_count: 0,
      },
      "https://app.immojudis.test",
    );

    const disabled = buildPropertyReportShare(
      {
        share_enabled: false,
        share_token: "abcDEF123_-abcDEF123_-abcDEF123",
        shared_at: null,
        share_expires_at: null,
        share_view_count: 0,
      },
      "https://app.immojudis.test",
    );

    expect(active.url).toBe(
      "https://app.immojudis.test/reports/shared/abcDEF123_-abcDEF123_-abcDEF123",
    );
    expect(disabled.url).toBeNull();
  });

  it("builds opportunity metrics for judicial-sale reports", () => {
    const acquisition = computeAcquisitionCosts({ price: 140_000, works: 25_000, fpt: 5_000 });
    const opportunity = buildOpportunityAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        starting_price_eur: 120_000,
        app_surface_m2: 80,
        department: "33",
        investment_score: 78,
        score_confidence: 0.84,
      },
      surfaceM2: 80,
      marketEstimate: {
        source: "DVF Cerema",
        yearsBack: 3,
        areaKind: "urban",
        commune: "Bordeaux",
        medianPricePerM2: 2_000,
        p25PricePerM2: 1_800,
        p75PricePerM2: 2_300,
        estimatedValueLowEur: 116_000,
        estimatedValueHighEur: 249_000,
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
      },
      ceilingSnapshot: {
        version: 2,
        project: "habiter",
        projectLabel: "Habiter",
        scenario: "prudent",
        profileLabel: "Prudent",
        works: { key: "devis", amount: 30_000 },
        occupation: "libre",
        basisLabel: "valeur estimée Immojudis",
        steps: [],
        available: true,
        reason: null,
        regime: "tribunal" as const,
        label: "Enchère plafond (simulation)",
        scopeNote: null,
        reserveNotice: null,
        estimatedFees: [],
        maxBid: 130_000,
        maxBidWithoutWorks: 160_000,
        maxBidWithRefreshWorks: 130_000,
        refreshWorksBudget: 30_000,
        targetTotalCost: 145_000,
        marketReferencePricePerM2: 2_000,
        safetyDiscountPct: 8,
        marginTotal: 8_000,
        marginPerM2: 100,
        acquisition,
      },
    });

    expect(opportunity.rentabilityScore).toEqual(
      computeRentabilityScore({
        surface: 80,
        price: 140_000,
        works: 25_000,
        fpt: 5_000,
        department: "33",
        marketMarginPerM2: 100,
      }),
    );
    expect(opportunity.acquisitionCosts.price).toBe(140_000);
    expect(opportunity).toMatchObject({
      score: 78,
      scoreConfidencePct: 84,
      label: "À étudier en priorité",
      startingPricePerM2: 1_500,
      estimatedMarketValue: 160_000,
      estimatedMarketLow: 116_000,
      estimatedMarketHigh: 249_000,
      estimatedMarketRangeLabel: "Fourchette de valeur estimée",
      apparentDiscountPct: 25,
      // 9,9 % avec 3 000 € de frais préalables par défaut ; 9,8 % avec les 5 000 € retenus partout.
      grossYieldPct: 9.8,
      rentabilityScore: {
        available: true,
        rentSource: "department_estimate",
        monthlyRent: 1_120,
      },
      acquisitionCosts: {
        acquisitionFeesTotal: Math.round(acquisition.acquisitionFeesTotal),
        totalCost: Math.round(acquisition.totalCost),
      },
      bidCeiling: {
        maxBid: 130_000,
        marginTotal: 8_000,
      },
    });
  });

  it("scores the rentability of a notarial sale on the fees of its own regime", () => {
    const sale = {
      ...EXAMPLE_SALE,
      sale_venue_type: "notary",
      sale_procedure: null,
      source_blocks: null,
      sale_legal_framework: "voluntary_notarial",
      starting_price_eur: 50_000,
      sale_conditions: {
        procedure: "online_tender",
        first_offer_eur: 50_000,
        negotiation_fee_rate: 0.05,
        negotiation_fee_payer: "ACQUEREUR",
        advertising_fees_eur: 1_200,
      },
    } as unknown as typeof EXAMPLE_SALE;
    const ceilingSnapshot = buildCeilingSnapshot(sale, null, {}, DEFAULT_OPEN_FEE_REGIMES);
    expect(ceilingSnapshot.regime).toBe("notary_online");
    const { acquisition } = ceilingSnapshot;
    expect(acquisition.negotiationFees).toBeCloseTo(2_500);
    expect(acquisition.advertisingFees).toBe(1_200);
    expect(acquisition.fpt).toBe(0);

    const { rentabilityScore } = buildOpportunityAnalysis({
      sale,
      surfaceM2: 60,
      marketEstimate: null,
      ceilingSnapshot,
    });
    // Same total as the ceiling snapshot (negotiation and advertising fees included) ...
    expect(rentabilityScore.totalCost).toBe(Math.round(acquisition.totalCost));
    // ... and not the one of a court sale at the same price.
    const asCourt = computeRentabilityScore({
      surface: 60,
      price: acquisition.price,
      works: acquisition.works,
      fpt: acquisition.fpt,
      department: sale.department,
    });
    expect(rentabilityScore.totalCost).toBeGreaterThan(asCourt.totalCost);
  });

  it("gives administrators Analyse entitlements for premium offer testing", async () => {
    const auth = {
      userId: "11111111-1111-4111-8111-111111111111",
      claims: { app_metadata: { role: "admin" } },
      accountTier: "premium",
      userRole: "admin",
      isAdmin: true,
      supabase: {
        from() {
          throw new Error("Admin entitlements should not query user_subscriptions.");
        },
      },
    } as unknown as SupabaseAuthContext;

    const plan = await resolvePlanEntitlements(auth);

    expect(plan.plan).toBe("analyse");
    expect(plan.hasAnalysisAccess).toBe(true);
    expect(plan.features.realtimeAlertChanges).toBe("included");
    expect(plan.features.workspaceCollaboration).toBe("included");
    expect(plan.features.outcomeGraph).toBe("included");
    expect(plan.limits.workspaceCollaborators).toBeNull();
    expect(plan.limits.watchedZones).toBeNull();
    expect(plan.limits.apiKeys).toBeNull();
  });

  it("keeps commercial Analyse quotas for a manually promoted premium user", async () => {
    const auth = {
      userId: "22222222-2222-4222-8222-222222222222",
      claims: {},
      accountTier: "premium",
      userRole: "user",
      isAdmin: false,
      supabase: {
        from() {
          throw new Error("Manual premium entitlements should not query user_subscriptions.");
        },
      },
    } as unknown as SupabaseAuthContext;

    const plan = await resolvePlanEntitlements(auth);

    expect(plan.plan).toBe("analyse");
    expect(plan.features.outcomeGraph).toBe("included");
    expect(plan.limits.apiKeys).toBe(2);
    expect(plan.limits.watchedZones).toBe(25);
    expect(plan.limits.workspaceCollaborators).toBe(25);
  });
});

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
