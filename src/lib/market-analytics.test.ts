import { describe, expect, it } from "vitest";
import {
  buildMarketAnalyticsSnapshot,
  marketAnalyticsQuerySchema,
  type MarketAnalyticsItem,
} from "./market-analytics";

function makeItem(overrides: Partial<MarketAnalyticsItem> = {}): MarketAnalyticsItem {
  return {
    id: "7d335032-e935-4550-9347-ed22b0f63449",
    title: "Maison judiciaire",
    city: "Bordeaux",
    department: "33",
    tribunalCode: "tj-bordeaux",
    tribunalName: "TJ Bordeaux",
    propertyType: "house",
    status: "active",
    saleDate: "2026-08-01T09:00:00.000Z",
    createdAt: "2026-07-01T09:00:00.000Z",
    startingPriceEur: 100_000,
    adjudicationPriceEur: null,
    surfaceM2: 50,
    pricePerM2: 2_000,
    investmentScore: 75,
    daysToSale: 31,
    isUpcoming: true,
    ...overrides,
  };
}

describe("market analytics", () => {
  it("validates scoped analytics requests", () => {
    expect(() => marketAnalyticsQuerySchema.parse({})).toThrow();

    expect(
      marketAnalyticsQuerySchema.parse({
        saleId: "7d335032-e935-4550-9347-ed22b0f63449",
        months: "24",
        futureMonths: "3",
        limit: "100",
      }),
    ).toMatchObject({
      saleId: "7d335032-e935-4550-9347-ed22b0f63449",
      months: 24,
      futureMonths: 3,
      limit: 100,
    });
  });

  it("builds market distribution, trends and local segments", () => {
    const snapshot = buildMarketAnalyticsSnapshot([
      makeItem(),
      makeItem({
        id: "0d335032-e935-4550-9347-ed22b0f63440",
        city: "Nantes",
        department: "44",
        saleDate: "2026-08-20T09:00:00.000Z",
        startingPriceEur: 200_000,
        pricePerM2: 2_500,
        investmentScore: 65,
        daysToSale: 40,
        isUpcoming: true,
      }),
      makeItem({
        id: "1d335032-e935-4550-9347-ed22b0f63441",
        city: "Bordeaux",
        saleDate: "2026-07-10T09:00:00.000Z",
        startingPriceEur: 80_000,
        pricePerM2: 1_600,
        investmentScore: 85,
        daysToSale: 20,
        isUpcoming: false,
      }),
    ]);

    expect(snapshot.summary).toMatchObject({
      sampleSize: 3,
      upcomingCount: 2,
      pastCount: 1,
      medianStartingPriceEur: 100_000,
      medianPricePerM2: 2_000,
      averageInvestmentScore: 75,
      averageDaysToSale: 30.3,
    });
    expect(
      snapshot.priceDistribution.find((bucket) => bucket.label === "100-200 k€"),
    ).toMatchObject({
      count: 1,
      sharePct: 33.3,
    });
    expect(snapshot.volumeEvolution).toEqual([
      {
        period: "2026-07",
        count: 1,
        medianStartingPriceEur: 80_000,
        medianPricePerM2: 1_600,
        averageDaysToSale: 20,
      },
      {
        period: "2026-08",
        count: 2,
        medianStartingPriceEur: 150_000,
        medianPricePerM2: 2_250,
        averageDaysToSale: 35.5,
      },
    ]);
    expect(snapshot.comparisonSegments[0]).toMatchObject({
      label: "Bordeaux",
      segmentKind: "city",
      count: 2,
    });
    expect(snapshot.rotationRate).toMatchObject({
      label: "Pipeline très fourni",
      liquidityLabel: "Marché modérément liquide",
      upcomingCount: 2,
      pastCount: 1,
      monthlyVolume: 1.5,
      pipelineRatioPct: 200,
      averageDaysToSale: 30.3,
    });
    expect(snapshot.marketTrends).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: "price_per_m2",
          direction: "up",
          periodFrom: "2026-07",
          periodTo: "2026-08",
          startValue: 1_600,
          endValue: 2_250,
          changePct: 40.6,
        }),
        expect.objectContaining({
          metric: "volume",
          direction: "up",
          startValue: 1,
          endValue: 2,
          changePct: 100,
        }),
        expect.objectContaining({
          metric: "sale_delay",
          direction: "up",
          startValue: 20,
          endValue: 35.5,
          changePct: 77.5,
        }),
      ]),
    );
    expect(snapshot.communeComparison).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Bordeaux",
          segmentKind: "city",
          count: 2,
          medianPricePerM2: 1_800,
        }),
      ]),
    );
  });
});
