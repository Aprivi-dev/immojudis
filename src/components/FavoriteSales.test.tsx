// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { FavoriteSalesResponse } from "@/lib/favorites";
import type { AiReviewProjectionReadModel } from "@/lib/ai-review-guard";
import { FavoriteSales } from "./FavoriteSales";

const mocks = vi.hoisted(() => ({
  fetchFavoriteSales: vi.fn(),
  fetchSalesAiReviewProjections: vi.fn(),
  addFavoriteSale: vi.fn(),
  removeFavoriteSale: vi.fn(),
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "user-1" }, loading: false }),
}));

vi.mock("@/lib/client-api", () => ({
  fetchFavoriteSales: mocks.fetchFavoriteSales,
  fetchSalesAiReviewProjections: mocks.fetchSalesAiReviewProjections,
  addFavoriteSale: mocks.addFavoriteSale,
  removeFavoriteSale: mocks.removeFavoriteSale,
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/hooks/use-viewed-sales", () => ({ useViewedSales: () => ({ isViewed: () => false }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

vi.mock("./FavoriteButton", () => ({
  FavoriteButton: ({ saleId }: { saleId: string }) => <button>Retirer {saleId}</button>,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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

    expect(await screen.findByText("Localisation à préciser")).toBeTruthy();
    expect(screen.getAllByText("À confirmer").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("Bordeaux · Gironde")).toBeNull();
    expect(screen.queryByText(/92\s?000/)).toBeNull();
    expect(screen.queryByText(/15 octobre 2026/)).toBeNull();
    expect(mocks.fetchSalesAiReviewProjections).toHaveBeenCalledWith(["sale-1"]);
  });

  it("réutilise la carte du catalogue et propose Annuler après le retrait d'un favori", async () => {
    mocks.fetchFavoriteSales.mockResolvedValue(favoritesResponse());
    mocks.fetchSalesAiReviewProjections.mockResolvedValue({ projections: [] });
    mocks.removeFavoriteSale.mockResolvedValue({ ok: true, removed: true });
    mocks.addFavoriteSale.mockResolvedValue({ favorite: null, created: true });

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <FavoriteSales />
      </QueryClientProvider>,
    );

    await screen.findByText("Bordeaux · Gironde");
    expect(screen.getByText("Mise à prix")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ne plus suivre cette vente" }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    const [message, options] = mocks.toast.mock.calls[0];
    expect(message).toBe("Favori supprimé");
    expect(options.duration).toBe(5000);
    expect(options.action.label).toBe("Annuler");
    options.action.onClick();
    await waitFor(() =>
      expect(mocks.addFavoriteSale).toHaveBeenCalledWith({ data: { saleId: "sale-1" } }),
    );
  });

  it("propose un état vide qui renvoie vers le catalogue", async () => {
    mocks.fetchFavoriteSales.mockResolvedValue({
      ...favoritesResponse(),
      favorites: [],
    });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <FavoriteSales />
      </QueryClientProvider>,
    );
    await screen.findByText("Aucun favori pour le moment");
    expect(screen.getByRole("link", { name: "Voir les ventes" }).getAttribute("href")).toBe(
      "/sales",
    );
  });
});
