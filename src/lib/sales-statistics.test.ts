import { describe, expect, it } from "vitest";
import { buildSalesStatisticsResponse, buildSalesStatisticsSummary } from "@/lib/sales-statistics";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { AuctionSale } from "@/lib/types";

function makeSale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    ...EXAMPLE_SALE,
    id: overrides.id ?? crypto.randomUUID(),
    title: "Vente statistique",
    starting_price_eur: 100_000,
    app_surface_m2: 50,
    investment_score: 70,
    sale_date: "2026-07-20T09:00:00.000Z",
    status: "active",
    source_blocks: { dpe_classe: "C" },
    ...overrides,
  };
}

describe("sales statistics", () => {
  it("builds aggregate search statistics from judicial sales", () => {
    const summary = buildSalesStatisticsSummary(
      [
        makeSale({
          id: "sale-1",
          department: "33",
          property_type: "house",
          starting_price_eur: 100_000,
          app_surface_m2: 50,
          investment_score: 70,
          source_blocks: { dpe_classe: "C" },
        }),
        makeSale({
          id: "sale-2",
          department: "33",
          property_type: "apartment",
          starting_price_eur: 200_000,
          app_surface_m2: 100,
          investment_score: 80,
          sale_date: "2026-06-01T09:00:00.000Z",
          source_blocks: { dpe_classe: "D" },
          adjudication_price_eur: 230_000,
          status: "adjudicated",
        }),
        makeSale({
          id: "sale-3",
          department: "75",
          property_type: "apartment",
          starting_price_eur: 300_000,
          app_surface_m2: null,
          investment_score: null,
          source_blocks: null,
        }),
      ],
      false,
      new Date("2026-07-06T00:00:00.000Z"),
    );

    expect(summary).toMatchObject({
      sampleSize: 3,
      capped: false,
      medianPriceEur: 200_000,
      averagePriceEur: 200_000,
      medianPricePerM2: 2_000,
      averageInvestmentScore: 75,
      medianInvestmentScore: 75,
      upcomingSales: 2,
      adjudicatedSales: 1,
      dpeKnownCount: 2,
    });
    expect(summary.dpeCounts).toMatchObject({
      C: 1,
      D: 1,
    });
    expect(summary.averageGrossYieldPct).not.toBeNull();
  });

  it("returns ranked property, department and status segments", () => {
    const response = buildSalesStatisticsResponse({
      sales: [
        makeSale({
          id: "sale-1",
          department: "33",
          property_type: "apartment",
          status: "active",
        }),
        makeSale({
          id: "sale-2",
          department: "33",
          property_type: "apartment",
          status: "active",
        }),
        makeSale({
          id: "sale-3",
          department: "75",
          property_type: "house",
          status: "adjudicated",
        }),
      ],
      capped: true,
      search: { department: "33" },
      now: new Date("2026-07-06T00:00:00.000Z"),
    });

    expect(response.summary.capped).toBe(true);
    expect(response.segments.propertyTypes[0]).toMatchObject({
      key: "apartment",
      count: 2,
      sharePct: 66.7,
    });
    expect(response.segments.departments[0]).toMatchObject({
      key: "33",
      count: 2,
    });
    expect(response.meta.filters).toMatchObject({
      department: "33",
    });
  });
});
