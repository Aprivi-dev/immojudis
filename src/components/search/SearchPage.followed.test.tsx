// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";

vi.setConfig({ testTimeout: 15_000 });

/**
 * /sales pour un abonné de l'offre Analyse (maquette « sales-analyse ») : bandeau « Votre suivi »
 * sous le titre, ligne « Mon dossier » et dernier changement sur les cartes des ventes suivies.
 * Rien de tout cela n'est lu pour l'offre Découverte.
 */
const state = vi.hoisted(() => ({
  auth: { user: { id: "user-1" } as null | { id: string }, loading: false },
  plan: { hasAnalysisAccess: true },
  fetchAccessPlan: vi.fn(),
  fetchSearchResults: vi.fn(),
  fetchSearchCount: vi.fn(),
  fetchFavoriteSales: vi.fn(),
  fetchSaleChangeEvents: vi.fn(),
  fetchAlertNotifications: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ session: null, authError: null, profile: null, ...state.auth }),
}));
vi.mock("./MapPanel", () => ({ MapPanel: () => <div data-testid="map-panel" /> }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/sales",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/client-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-api")>()),
  fetchAccessPlan: state.fetchAccessPlan,
  fetchSalesAiReviewProjections: vi.fn(async () => ({ projections: [] })),
  fetchNotificationPreferences: vi.fn(async () => ({ preferences: {} })),
  fetchSaleUnlocksOverview: vi.fn(async () => ({ status: {}, sales: [] })),
  fetchFavoriteSales: state.fetchFavoriteSales,
  fetchSaleChangeEvents: state.fetchSaleChangeEvents,
  fetchAlertNotifications: state.fetchAlertNotifications,
}));
vi.mock("@/lib/client-billing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-billing")>()),
  fetchAccessPlan: state.fetchAccessPlan,
}));
vi.mock("@/lib/search/search-service", () => ({
  fetchSearchResults: state.fetchSearchResults,
  fetchSearchCount: state.fetchSearchCount,
  fetchSearchMapResults: vi.fn(async () => []),
  fetchSearchPhotoMirrors: vi.fn(async () => new Map()),
}));

import { SearchPage } from "./SearchPage";

const rows = ["a", "b"].map((id) => ({
  id: `sale-${id}`,
  starting_price_eur: 142_000,
  sale_venue_type: "tribunal",
  sale_verification_status: "verified",
  city: `Ville ${id}`,
  department: "69",
  property_type: "apartment",
  sale_date: "2099-11-27T09:00:00Z",
  app_surface_m2: 62,
  occupancy_status: "libre",
  media: [],
})) as unknown as AuctionSale[];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SearchPage search={{}} serverSeeded={false} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.auth = { user: { id: "user-1" }, loading: false };
  state.fetchAccessPlan.mockReset().mockImplementation(async () => ({
    plan: {
      plan: state.plan.hasAnalysisAccess ? "analyse" : "decouverte",
      hasAnalysisAccess: state.plan.hasAnalysisAccess,
      features: {},
    },
  }));
  state.fetchSearchResults.mockReset().mockResolvedValue(rows);
  state.fetchSearchCount.mockReset().mockResolvedValue(rows.length);
  state.fetchFavoriteSales.mockReset().mockResolvedValue({
    favorites: [
      {
        id: "fav-a",
        saleId: "sale-a",
        favoritedAt: "2026-10-01T10:00:00Z",
        sale: rows[0],
        personalStatus: "bidding",
        bidCeilingEur: 151_000,
        bidCeilingSavedAt: "2026-10-02T10:00:00Z",
      },
    ],
    unavailableSaleIds: [],
    summary: {},
    plan: { code: "analyse" },
  });
  state.fetchSaleChangeEvents.mockReset().mockResolvedValue({
    events: [
      {
        id: "event-1",
        saleId: "sale-a",
        watchKind: "favorite",
        watchId: "fav-a",
        eventKind: "price_changed",
        severity: "info",
        fingerprint: "price-1",
        summaryLabel: "Mise à prix modifiée",
        changeSummary: { previousValue: 160_000, currentValue: 142_000 },
        detectedAt: new Date().toISOString(),
        readAt: null,
        dismissedAt: null,
      },
    ],
  });
  state.fetchAlertNotifications.mockReset().mockResolvedValue({
    notifications: [
      { id: "n1", alertId: "alert-1", saleId: "sale-x", readAt: null, dismissedAt: null },
      { id: "n2", alertId: "alert-2", saleId: "sale-y", readAt: null, dismissedAt: null },
      { id: "n3", alertId: "alert-2", saleId: "sale-z", readAt: "2026-11-01", dismissedAt: null },
    ],
  });
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  window.history.replaceState(null, "", "/sales");
});
afterEach(cleanup);

describe("/sales : abonné de l'offre Analyse", () => {
  it("montre « Votre suivi » sous le titre, avec les seules données connues", async () => {
    renderPage();
    const nav = await screen.findByRole("navigation", { name: "Votre suivi" });
    await waitFor(() => expect(within(nav).getAllByRole("link")).toHaveLength(3));
    const texts = within(nav)
      .getAllByRole("link")
      .map((link) => link.textContent);
    expect(texts[0]).toContain("1vente suivie");
    expect(texts[1]).toContain("1changement");
    expect(texts[2]).toContain("2nouvelles ventes");
    expect(texts[2]).toContain("dans vos 2 alertes");
    // Le chapô du visiteur laisse la place au suivi.
    expect(screen.queryByText(/réunies au même endroit/)).toBeNull();
  });

  it("met « Mon dossier » et le dernier changement sur la carte de la vente suivie seulement", async () => {
    renderPage();
    const dossier = await screen.findByTestId("card-dossier");
    const cards = screen.getAllByRole("article");
    expect(cards[0].contains(dossier)).toBe(true);
    expect(dossier.textContent).toMatch(/^Je prépare mon enchèreMon plafond : 151\s000\s€$/);
    expect((await within(cards[0]).findByTestId("card-last-change")).textContent).toMatch(
      /^Mise à prix abaissée · 160\s000\s€ → 142\s000\s€$/,
    );
    expect(within(cards[1]).queryByTestId("card-dossier")).toBeNull();
    // L'abonné voit l'occupation dans la fiche technique.
    expect(within(cards[0]).getByText("Occupation")).toBeTruthy();
  });

  it("ne lit rien de tout cela pour l'offre Découverte", async () => {
    state.plan.hasAnalysisAccess = false;
    try {
      renderPage();
      await screen.findAllByRole("article");
      await waitFor(() => expect(state.fetchAccessPlan).toHaveBeenCalled());
      expect(state.fetchFavoriteSales).not.toHaveBeenCalled();
      expect(state.fetchSaleChangeEvents).not.toHaveBeenCalled();
      expect(screen.queryByRole("navigation", { name: "Votre suivi" })).toBeNull();
      expect(screen.queryByTestId("card-dossier")).toBeNull();
    } finally {
      state.plan.hasAnalysisAccess = true;
    }
  });
});
