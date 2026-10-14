import { describe, expect, it } from "vitest";
import type { MarketContext, MarketEstimate } from "@/lib/market-server/types";
import {
  ceilingMarketContext,
  ceilingMarketEstimate,
  isDetailedMarketEstimate,
} from "@/lib/market-estimate-ceiling";

const detailed: MarketEstimate = {
  source: "DVF normalisé",
  sourceUrl: "https://example.test/dvf",
  sourceUpdatedAt: "2026-09-01T00:00:00.000Z",
  engineVersion: "v3",
  subjectSurfaceM2: 60,
  subjectSurfaceEstimated: true,
  estimatedValueEur: 210_000,
  estimatedValueLowEur: 190_000,
  estimatedValueHighEur: 230_000,
  actionable: true,
  radiusM: 800,
  yearsBack: 3,
  areaKind: "urban",
  commune: "Lyon",
  sampleSize: 14,
  effectiveSampleSize: 9,
  parcelSampleSize: 12,
  totalNearbySampleSize: 40,
  outliersRemoved: 2,
  qualityScore: 71,
  qualityLabel: "correcte",
  qualityWarnings: [],
  comparableMode: "nearby_type_only",
  surfaceMinM2: 40,
  surfaceMaxM2: 90,
  medianPricePerM2: 3_500,
  p10PricePerM2: 2_800,
  p25PricePerM2: 3_100,
  p75PricePerM2: 3_900,
  p90PricePerM2: 4_300,
  minPricePerM2: 2_500,
  maxPricePerM2: 4_800,
  deviationPct: null,
  addressHistory: [
    {
      date: "2024-01-01",
      totalPrice: 190_000,
      surface: 58,
      pricePerM2: 3_276,
      type: "Appartement",
    },
  ],
  recentTransactions: [
    {
      date: "2025-02-01",
      pricePerM2: 3_400,
      surface: 62,
      totalPrice: 210_800,
      type: "Appartement",
      distanceM: 120,
    },
  ],
};

describe("ceiling projection of the market estimate", () => {
  it("keeps only what the bid ceiling reads", () => {
    expect(ceilingMarketEstimate(detailed)).toEqual({
      source: "DVF normalisé",
      sourceUpdatedAt: "2026-09-01T00:00:00.000Z",
      subjectSurfaceEstimated: true,
      estimatedValueEur: 210_000,
      actionable: true,
      qualityLabel: "correcte",
      sampleSize: 9,
      medianPricePerM2: 3_500,
      p75PricePerM2: 3_900,
    });
  });

  it("sends no distribution, range, comparable, address history or location", () => {
    const sent = JSON.stringify(
      ceilingMarketContext({ ok: true, error: null, estimate: detailed }),
    );
    for (const field of [
      "p10PricePerM2",
      "p25PricePerM2",
      "p90PricePerM2",
      "minPricePerM2",
      "maxPricePerM2",
      "estimatedValueLowEur",
      "estimatedValueHighEur",
      "recentTransactions",
      "addressHistory",
      "effectiveSampleSize",
      "totalNearbySampleSize",
      "commune",
      "radiusM",
      "sourceUrl",
    ]) {
      expect(sent).not.toContain(`"${field}"`);
    }
  });

  it("falls back to the plain sample size", () => {
    const { effectiveSampleSize: _unused, ...rest } = detailed;
    expect(ceilingMarketEstimate(rest).sampleSize).toBe(14);
  });

  it("keeps the status fields of the context and an empty estimate", () => {
    const context: MarketContext = {
      ok: false,
      error: "Estimation à recalculer.",
      estimate: null,
      status: "queued",
      code: null,
      retryAfterSeconds: 15,
      computedAt: "2026-10-01T00:00:00.000Z",
    };
    expect(ceilingMarketContext(context)).toEqual(context);
  });

  it("tells the detailed estimate from the projection", () => {
    expect(isDetailedMarketEstimate(detailed)).toBe(true);
    expect(isDetailedMarketEstimate(ceilingMarketEstimate(detailed))).toBe(false);
    expect(isDetailedMarketEstimate(null)).toBe(false);
  });
});
