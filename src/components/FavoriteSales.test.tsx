// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { FavoriteSalesResponse } from "@/lib/favorites";
import type { AiReviewProjectionReadModel } from "@/lib/ai-review-guard";
import { FavoriteSales } from "./FavoriteSales";

const mocks = vi.hoisted(() => ({
  fetchFavoriteSales: vi.fn(),
  fetchSalesAiReviewProjections: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "user-1" }, loading: false }),
}));

vi.mock("@/lib/client-api", () => ({
  fetchFavoriteSales: mocks.fetchFavoriteSales,
  fetchSalesAiReviewProjections: mocks.fetchSalesAiReviewProjections,
}));

vi.mock("./FavoriteButton", () => ({
  FavoriteButton: ({ saleId }: { saleId: string }) => <button>Retirer {saleId}</button>,
}));

afterEach(cleanup);

function favoritesResponse(): FavoriteSalesResponse {
  return {
    favorites: [
      {
        id: "favorite-1",
        saleId: "sale-1",
        favoritedAt: "2026-09-01T10:00:00.000Z",
        sale: { ...EXAMPLE_SALE, id: "sale-1" },
      },
    ],
    unavailableSaleIds: [],
    summary: {
      total: 1,
      upcomingAudiences: 1,
      nextAudienceAt: "2026-10-15T09:30:00.000Z",
      totalStartingPriceEur: 92_000,
      averageStartingPriceEur: 92_000,
      averageInvestmentScore: 78,
      departments: [{ department: "Gironde", count: 1, totalStartingPriceEur: 92_000 }],
    },
    plan: {
      code: "analyse",
      label: "Analyse",
      feature: "included",
      limit: null,
    },
  } as FavoriteSalesResponse;
}

function blockedProjection(
  fieldKey: AiReviewProjectionReadModel["field_key"],
): AiReviewProjectionReadModel {
  return {
    auction_sale_id: "sale-1",
    field_key: fieldKey,
    review_state: "unresolved",
    citation_status: "not_required",
    is_publishable: false,
    source_name: "AGRASC",
    source_url: "https://agrasc.gouv.fr/vente/1",
  };
}

describe("FavoriteSales", () => {
  it("masks blocked city, price and date values in the client workspace", async () => {
    mocks.fetchFavoriteSales.mockResolvedValue(favoritesResponse());
    mocks.fetchSalesAiReviewProjections.mockResolvedValue({
      projections: [
        blockedProjection("property.city"),
        blockedProjection("sale.starting_price_eur"),
        blockedProjection("sale.sale_date"),
      ],
    });

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <FavoriteSales />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Localisation à confirmer")).toBeTruthy();
    expect(screen.getByText("Prix à confirmer")).toBeTruthy();
    expect(screen.getByText("Date à confirmer")).toBeTruthy();
    expect(screen.queryByText("Bordeaux · Gironde")).toBeNull();
    expect(screen.queryByText(/92\s?000/)).toBeNull();
    expect(screen.queryByText(/15 octobre 2026/)).toBeNull();
    expect(mocks.fetchSalesAiReviewProjections).toHaveBeenCalledWith(["sale-1"]);
  });
});
