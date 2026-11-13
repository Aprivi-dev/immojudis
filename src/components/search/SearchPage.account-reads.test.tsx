// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";

vi.setConfig({ testTimeout: 15_000 });

/**
 * Lectures réservées aux comptes connectés (`useSearchAccountData`) : aucune pour un visiteur
 * anonyme ; un compte de l'offre Analyse lit sa préférence de récapitulatif et la relecture IA des
 * ventes affichées.
 */
const state = vi.hoisted(() => ({
  auth: { user: null as null | { id: string }, loading: false },
  fetchAccessPlan: vi.fn(),
  fetchNotificationPreferences: vi.fn(),
  fetchSalesAiReviewProjections: vi.fn(),
  fetchSearchResults: vi.fn(),
  fetchSearchCount: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ ...state.auth, session: null, authError: null }),
}));
vi.mock("./MapPanel", () => ({ MapPanel: () => <div data-testid="map-panel" /> }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/sales",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/client-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-api")>()),
  fetchSalesAiReviewProjections: state.fetchSalesAiReviewProjections,
  fetchNotificationPreferences: state.fetchNotificationPreferences,
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
  starting_price_eur: 80_000,
  sale_venue_type: "tribunal",
  sale_verification_status: "verified",
  city: `Ville ${id}`,
  department: "33",
  property_type: "apartment",
  sale_date: "2099-10-20T09:00:00Z",
  app_surface_m2: 50,
  media: [],
})) as unknown as AuctionSale[];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SearchPage search={{ city: "Pau" }} serverSeeded={false} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.fetchAccessPlan.mockReset().mockResolvedValue({
    plan: {
      plan: "analyse",
      hasAnalysisAccess: true,
      features: {
        salesStatistics: "included",
        dpeExplorer: "included",
        salesCsvExport: "included",
        watchedZones: "included",
        smartAlerts: "included",
      },
    },
  });
  state.fetchNotificationPreferences
    .mockReset()
    .mockResolvedValue({ preferences: { alertEmailEnabled: true } });
  state.fetchSalesAiReviewProjections.mockReset().mockResolvedValue({ projections: [] });
  state.fetchSearchResults.mockReset().mockResolvedValue(rows);
  state.fetchSearchCount.mockReset().mockResolvedValue(rows.length);
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
});
afterEach(cleanup);

describe("/sales : lectures des comptes connectés", () => {
  it("ne part pas pour un visiteur anonyme", async () => {
    state.auth = { user: null, loading: false };
    renderPage();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(rows.length));

    expect(state.fetchNotificationPreferences).not.toHaveBeenCalled();
    expect(state.fetchSalesAiReviewProjections).not.toHaveBeenCalled();
  });

  it("part une fois le compte reconnu", async () => {
    state.auth = { user: { id: "user-1" }, loading: false };
    renderPage();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(rows.length));

    await waitFor(() => expect(state.fetchNotificationPreferences).toHaveBeenCalledTimes(1));
    // Offre Analyse, liste connectée : la relecture IA porte sur les ventes affichées.
    await waitFor(() =>
      expect(state.fetchSalesAiReviewProjections).toHaveBeenCalledWith(["sale-a", "sale-b"]),
    );
  });
});
