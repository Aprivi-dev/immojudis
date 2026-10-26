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

describe("sales statistics rents", () => {
  const reference = (rentPerM2: number) => ({
    rentPerM2,
    source: "anil_commune" as const,
    reliability: "reliable" as const,
    segment: "apt_all" as const,
    communeCode: "23096",
    lowPerM2: null,
    highPerM2: null,
    observations: 100,
    vintage: 2025,
    sourceUpdatedOn: "2025-12-11",
  });
  const sales = [
    makeSale({ id: "a", department: "23", starting_price_eur: 100_000, app_surface_m2: 50 }),
    makeSale({ id: "b", department: "23", starting_price_eur: 100_000, app_surface_m2: 50 }),
  ];

  it("averages the yields of the commune rents, and leaves a department without rent out", () => {
    expect(buildSalesStatisticsSummary(sales).averageGrossYieldPct).toBeNull();

    const summary = buildSalesStatisticsSummary(
      sales,
      false,
      new Date("2026-07-06T00:00:00.000Z"),
      (sale) => (sale.id === "a" ? reference(12) : reference(6)),
    );

    // About 6.2 % and 3.1 %.
    expect(summary.averageGrossYieldPct).toBeCloseTo(4.7, 1);
    expect(summary.medianGrossYieldPct).toBeCloseTo(4.7, 1);
  });

  it("carries the mandatory credit next to the yields", () => {
    const response = buildSalesStatisticsResponse({ sales, capped: false, search: {} });

    expect(response.meta.rentAttribution).toBe(
      "Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin.",
    );
  });

  it("says honestly what the yields are made of: ANIL, department, or both", () => {
    const build = (rents?: (sale: { id: string }) => ReturnType<typeof reference> | null) =>
      buildSalesStatisticsResponse({ sales, capped: false, search: {}, rents }).meta.rentBasis;
    const department = {
      rentPerM2: 14,
      source: "department_estimate" as const,
      reliability: "indicative" as const,
    };

    expect(build((sale) => (sale.id ? reference(12) : null))).toBe("anil");
    expect(build((sale) => (sale.id === "a" ? reference(12) : department) as never)).toBe("mixed");
    expect(build(undefined)).toBe("department");
    // Department 23 has no department rent: those sales have no yield and do not vote.
    expect(
      buildSalesStatisticsResponse({
        sales: [makeSale({ id: "x", department: "33" })],
        capped: false,
        search: {},
      }).meta.rentBasis,
    ).toBe("department");
  });

  it("leaves a property that is not a dwelling out of the yields", () => {
    const land = makeSale({ id: "terrain", department: "23", property_type: "land" });
    const summary = buildSalesStatisticsSummary([land], false, undefined, () => reference(12));

    expect(summary.averageGrossYieldPct).toBeNull();
  });
});

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
