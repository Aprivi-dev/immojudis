import { describe, expect, it } from "vitest";
import {
  buildSaleAnalysisSummary,
  saleAnalysisSetInputSchema,
  type SaleAnalysisItem,
} from "@/lib/sale-analysis-sets";

function makeItem(overrides: Partial<SaleAnalysisItem> = {}): SaleAnalysisItem {
  return {
    id: "item-1",
    analysis_set_id: "set-1",
    user_id: "user-1",
    sale_id: "7d335032-e935-4550-9347-ed22b0f63449",
    item_order: 0,
    decision_status: "watching",
    user_max_bid_eur: 120_000,
    target_yield_pct: 8,
    expected_margin_pct: 15,
    notes: null,
    created_at: "2026-07-06T10:00:00.000Z",
    updated_at: "2026-07-06T10:00:00.000Z",
    sale: {
      id: "7d335032-e935-4550-9347-ed22b0f63449",
      title: "Maison judiciaire",
      city: "Bordeaux",
      department: "33",
      startingPriceEur: 100_000,
      saleDate: "2026-08-01T09:00:00.000Z",
      investmentScore: 80,
    },
    ...overrides,
  };
}

describe("sale analysis sets", () => {
  it("validates multi-property analysis boundaries", () => {
    expect(() =>
      saleAnalysisSetInputSchema.parse({
        name: "Analyse vide",
        items: [],
      }),
    ).toThrow();

    expect(() =>
      saleAnalysisSetInputSchema.parse({
        name: "Analyse trop large",
        items: Array.from({ length: 13 }, (_, index) => ({
          saleId: `7d335032-e935-4550-9347-ed22b0f634${String(index).padStart(2, "0")}`,
        })),
      }),
    ).toThrow();

    expect(
      saleAnalysisSetInputSchema.parse({
        name: "Analyse Bordeaux",
        items: [
          {
            saleId: "7d335032-e935-4550-9347-ed22b0f63449",
            decisionStatus: "shortlisted",
            userMaxBidEur: 120_000,
          },
        ],
      }),
    ).toMatchObject({
      analysisKind: "comparison",
      items: [
        {
          decisionStatus: "shortlisted",
          userMaxBidEur: 120_000,
        },
      ],
    });
  });

  it("builds a useful aggregate summary", () => {
    const summary = buildSaleAnalysisSummary([
      makeItem(),
      makeItem({
        id: "item-2",
        sale_id: "0d335032-e935-4550-9347-ed22b0f63440",
        user_max_bid_eur: 90_000,
        sale: {
          id: "0d335032-e935-4550-9347-ed22b0f63440",
          title: "Appartement judiciaire",
          city: "Nantes",
          department: "44",
          startingPriceEur: 80_000,
          saleDate: "2026-07-20T09:00:00.000Z",
          investmentScore: 70,
        },
      }),
    ]);

    expect(summary).toEqual({
      itemCount: 2,
      totalStartingPriceEur: 180_000,
      totalUserMaxBidEur: 210_000,
      averageInvestmentScore: 75,
      earliestSaleDate: "2026-07-20T09:00:00.000Z",
      cities: ["Bordeaux", "Nantes"],
    });
  });
});
