import { describe, expect, it } from "vitest";
import {
  bidCeilingRequestSchema,
  buildBidCeilingAnalysis,
  type BidCeilingPlanAccess,
} from "@/lib/bid-ceiling";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { MarketEstimate } from "@/lib/market.functions";

const ANALYSE_PLAN: BidCeilingPlanAccess = {
  code: "analyse",
  label: "Analyse",
  feature: "included",
  advancedScenarios: "included",
};

const DISCOVERY_PLAN: BidCeilingPlanAccess = {
  code: "decouverte",
  label: "Découverte",
  feature: "limited",
  advancedScenarios: "locked",
};

const MARKET_ESTIMATE: MarketEstimate = {
  source: "DVF Cerema",
  radiusM: 300,
  yearsBack: 6,
  areaKind: "urban",
  commune: "Bordeaux",
  sampleSize: 18,
  parcelSampleSize: 18,
  totalNearbySampleSize: 24,
  outliersRemoved: 2,
  qualityScore: 82,
  qualityLabel: "forte",
  qualityWarnings: [],
  comparableMode: "surface_matched",
  surfaceMinM2: 50,
  surfaceMaxM2: 110,
  medianPricePerM2: 3_000,
  p25PricePerM2: 2_650,
  p75PricePerM2: 3_400,
  minPricePerM2: 2_300,
  maxPricePerM2: 4_000,
  deviationPct: null,
  addressHistory: [],
  recentTransactions: [],
};

describe("bid ceiling analysis", () => {
  it("validates calculator inputs for an authenticated API request", () => {
    expect(
      bidCeilingRequestSchema.parse({
        saleId: "7d335032-e935-4550-9347-ed22b0f63449",
        scenario: "custom",
        customSafetyDiscountPct: 18,
        worksEur: 25_000,
      }),
    ).toMatchObject({
      saleId: "7d335032-e935-4550-9347-ed22b0f63449",
      scenario: "custom",
      worksEur: 25_000,
    });
    expect(() => bidCeilingRequestSchema.parse({ saleId: "bad-id" })).toThrow();
  });

  it("builds paid max-bid scenarios with budget and rentability context", () => {
    const analysis = buildBidCeilingAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        id: "7d335032-e935-4550-9347-ed22b0f63449",
        title: "Maison judiciaire",
        starting_price_eur: 120_000,
        app_surface_m2: 80,
        app_surface_kind: "habitable",
      },
      input: bidCeilingRequestSchema.parse({
        saleId: "7d335032-e935-4550-9347-ed22b0f63449",
        scenario: "equilibre",
        simulatedBidEur: 135_000,
        userBudgetEur: 230_000,
        worksEur: 20_000,
        fptEur: 5_000,
        monthlyRentEur: 950,
        targetGrossYieldPct: 7,
      }),
      marketEstimate: MARKET_ESTIMATE,
      plan: ANALYSE_PLAN,
    });

    expect(analysis.sale).toMatchObject({
      title: "Maison judiciaire",
      surfaceM2: 80,
      surfaceKind: "recorded",
    });
    expect(analysis.marketReference).toMatchObject({
      source: "dvf",
      medianPricePerM2: 3_000,
      sampleSize: 18,
    });
    expect(analysis.scenarios.map((scenario) => scenario.key)).toEqual([
      "prudent",
      "equilibre",
      "offensif",
    ]);
    expect(analysis.selected.key).toBe("equilibre");
    expect(analysis.selected.result.available).toBe(true);
    expect(analysis.budget.selectedMaxBidEur).toBeGreaterThan(0);
    expect(analysis.budget.withinSelectedCeiling).toBe(false);
    expect(analysis.rentabilityAtSelectedMaxBid.available).toBe(true);
    expect(analysis.compliance.limitations[0]).toContain("aide à la décision");
  });

  it("limits Decouverte to the selected simple scenario", () => {
    const analysis = buildBidCeilingAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        app_surface_m2: 80,
      },
      input: bidCeilingRequestSchema.parse({
        saleId: "7d335032-e935-4550-9347-ed22b0f63449",
      }),
      marketEstimate: MARKET_ESTIMATE,
      plan: DISCOVERY_PLAN,
    });

    expect(analysis.plan).toMatchObject({
      code: "decouverte",
      feature: "limited",
      advancedScenarios: "locked",
    });
    expect(analysis.scenarios).toHaveLength(1);
    expect(analysis.scenarios[0].key).toBe("equilibre");
  });
});
