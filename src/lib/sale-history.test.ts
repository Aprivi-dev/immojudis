import { describe, expect, it } from "vitest";
import {
  buildSaleHistorySummary,
  saleHistoryQuerySchema,
  type SaleHistoryItem,
} from "./sale-history";

function makeHistoryItem(overrides: Partial<SaleHistoryItem> = {}): SaleHistoryItem {
  return {
    id: "7d335032-e935-4550-9347-ed22b0f63449",
    title: "Maison adjugée",
    city: "Bordeaux",
    department: "33",
    postalCode: "33000",
    address: "Rue exemple",
    tribunal: "TJ Bordeaux",
    tribunalCode: "tj-bordeaux",
    propertyType: "house",
    saleDate: "2025-07-01T09:00:00.000Z",
    status: "adjudicated",
    startingPriceEur: 100_000,
    adjudicationPriceEur: 130_000,
    surfaceM2: 65,
    pricePerM2: 2_000,
    adjudicationVsStartingPct: 30,
    investmentScore: 76,
    sourceName: "TJ",
    sourceUrl: "https://example.test",
    ...overrides,
  };
}

describe("sale history", () => {
  it("validates scoped history requests", () => {
    expect(() => saleHistoryQuerySchema.parse({})).toThrow();

    expect(
      saleHistoryQuerySchema.parse({
        saleId: "7d335032-e935-4550-9347-ed22b0f63449",
      }),
    ).toMatchObject({
      saleId: "7d335032-e935-4550-9347-ed22b0f63449",
      months: 60,
      limit: 12,
    });

    expect(
      saleHistoryQuerySchema.parse({
        department: "33",
        city: "Bordeaux",
        months: "24",
        limit: "6",
      }),
    ).toMatchObject({
      department: "33",
      city: "Bordeaux",
      months: 24,
      limit: 6,
    });
  });

  it("summarizes past judicial sales", () => {
    const summary = buildSaleHistorySummary([
      makeHistoryItem(),
      makeHistoryItem({
        id: "0d335032-e935-4550-9347-ed22b0f63440",
        city: "Nantes",
        department: "44",
        saleDate: "2024-05-20T09:00:00.000Z",
        startingPriceEur: 80_000,
        adjudicationPriceEur: null,
        pricePerM2: 1_600,
        adjudicationVsStartingPct: null,
      }),
      makeHistoryItem({
        id: "1d335032-e935-4550-9347-ed22b0f63441",
        saleDate: "2025-10-10T09:00:00.000Z",
        startingPriceEur: 120_000,
        adjudicationPriceEur: 150_000,
        pricePerM2: 2_300,
        adjudicationVsStartingPct: 25,
      }),
    ]);

    expect(summary).toEqual({
      itemCount: 3,
      adjudicatedCount: 2,
      averageStartingPriceEur: 100_000,
      medianStartingPriceEur: 100_000,
      averageAdjudicationPriceEur: 140_000,
      averagePricePerM2: 1_966.7,
      averageAdjudicationVsStartingPct: 27.5,
      earliestSaleDate: "2024-05-20T09:00:00.000Z",
      latestSaleDate: "2025-10-10T09:00:00.000Z",
      cities: ["Bordeaux", "Nantes"],
    });
  });
});
