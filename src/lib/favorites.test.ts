import { describe, expect, it } from "vitest";
import {
  buildFavoriteSalesSummary,
  favoriteSaleInputSchema,
  joinFavoriteRowsToSales,
} from "@/lib/favorites";
import { EXAMPLE_SALE } from "@/lib/example-sale";

describe("favorite sales workspace", () => {
  it("validates sale identifiers accepted by the favorites API", () => {
    expect(
      favoriteSaleInputSchema.parse({
        saleId: "7d335032-e935-4550-9347-ed22b0f63449",
      }),
    ).toEqual({
      saleId: "7d335032-e935-4550-9347-ed22b0f63449",
    });
    expect(() => favoriteSaleInputSchema.parse({ saleId: "not-a-sale" })).toThrow();
  });

  it("joins favorite rows to sales while preserving the user's tracking order", () => {
    const favorites = joinFavoriteRowsToSales(
      [
        {
          id: "fav-1",
          sale_id: "sale-2",
          created_at: "2026-07-06T12:00:00.000Z",
        },
        {
          id: "fav-2",
          sale_id: "missing-sale",
          created_at: "2026-07-06T11:00:00.000Z",
        },
        {
          id: "fav-3",
          sale_id: "sale-1",
          created_at: "2026-07-06T10:00:00.000Z",
        },
      ],
      [
        {
          ...EXAMPLE_SALE,
          id: "sale-1",
          title: "Appartement suivi",
        },
        {
          ...EXAMPLE_SALE,
          id: "sale-2",
          title: "Maison prioritaire",
        },
      ],
    );

    expect(favorites.map((favorite) => favorite.sale.title)).toEqual([
      "Maison prioritaire",
      "Appartement suivi",
    ]);
    expect(favorites[0]).toMatchObject({
      id: "fav-1",
      saleId: "sale-2",
      favoritedAt: "2026-07-06T12:00:00.000Z",
    });
  });

  it("builds a portfolio summary for followed judicial sales", () => {
    const favorites = joinFavoriteRowsToSales(
      [
        {
          id: "fav-1",
          sale_id: "sale-1",
          created_at: "2026-07-06T12:00:00.000Z",
        },
        {
          id: "fav-2",
          sale_id: "sale-2",
          created_at: "2026-07-06T11:00:00.000Z",
        },
        {
          id: "fav-3",
          sale_id: "sale-3",
          created_at: "2026-07-06T10:00:00.000Z",
        },
      ],
      [
        {
          ...EXAMPLE_SALE,
          id: "sale-1",
          department: "33",
          starting_price_eur: 100_000,
          investment_score: 70,
          sale_date: "2026-07-20T09:00:00.000Z",
        },
        {
          ...EXAMPLE_SALE,
          id: "sale-2",
          department: "33",
          starting_price_eur: 160_000,
          investment_score: 82,
          sale_date: "2026-07-12T09:00:00.000Z",
        },
        {
          ...EXAMPLE_SALE,
          id: "sale-3",
          department: "75",
          starting_price_eur: null,
          investment_score: null,
          sale_date: "2026-06-20T09:00:00.000Z",
        },
      ],
    );

    const summary = buildFavoriteSalesSummary(favorites, new Date("2026-07-06T00:00:00.000Z"));

    expect(summary).toEqual({
      total: 3,
      upcomingAudiences: 2,
      nextAudienceAt: "2026-07-12T09:00:00.000Z",
      totalStartingPriceEur: 260_000,
      averageStartingPriceEur: 130_000,
      averageInvestmentScore: 76,
      departments: [
        {
          department: "33",
          count: 2,
          totalStartingPriceEur: 260_000,
        },
        {
          department: "75",
          count: 1,
          totalStartingPriceEur: 0,
        },
      ],
    });
  });
});
