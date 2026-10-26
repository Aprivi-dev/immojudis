// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";
import type { SalesSearchParams } from "@/lib/search/search-url-state";

vi.setConfig({ testTimeout: 15_000 });

/**
 * Compte connecté : les filtres « sous la fourchette » et « Pépites seulement » sont appliqués par la RECHERCHE
 * (listes d'identifiants croisées avec les lignes). Le second passage de la page, local, ne les rejoue pas : il
 * n'a pas ces listes et viderait l'écran.
 */
const state = vi.hoisted(() => ({
  fetchAccessPlan: vi.fn(),
  fetchSearchResults: vi.fn(),
  fetchSearchCount: vi.fn(),
  pepiteIds: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "user-1" },
    loading: false,
    session: null,
    authError: null,
  }),
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
  fetchNotificationPreferences: vi.fn(async () => ({ preferences: { alertEmailEnabled: false } })),
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
vi.mock("@/lib/search/pepite-filter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/search/pepite-filter")>()),
  fetchPepiteSaleIds: state.pepiteIds,
}));

import { SearchPage } from "./SearchPage";

const rows = ["a", "b", "c"].map((id) => ({
  id: `sale-${id}`,
  starting_price_eur: 80_000,
  sale_venue_type: "tribunal",
  sale_verification_status: "verified",
  city: `Ville ${id}`,
  department: "33",
  property_type: "apartment",
  sale_date: "2099-10-20T09:00:00Z",
  app_surface_m2: 50,
  occupancy_status: "free",
  media: [],
})) as unknown as AuctionSale[];

function renderPage(search: SalesSearchParams) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SearchPage search={search} serverSeeded={false} />
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
  // La recherche rend déjà les lignes filtrées par ses listes d'identifiants.
  state.fetchSearchResults.mockReset().mockResolvedValue(rows);
  state.fetchSearchCount.mockReset().mockResolvedValue(rows.length);
  state.pepiteIds.mockReset().mockResolvedValue(new Set(["sale-a"]));
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

describe("/sales connecté : filtres appliqués par la recherche, pas rejoués localement", () => {
  it.each<[string, SalesSearchParams]>([
    ["« sous la fourchette »", { belowRange: true }],
    ["« Pépites seulement »", { pepite: true }],
    ["les deux ensemble", { pepite: true, belowRange: true }],
  ])("%s : les lignes de la recherche restent à l'écran", async (_label, search) => {
    renderPage(search);
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(rows.length));
    expect(state.fetchSearchResults).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.objectContaining(search) }),
    );
  });

  it("garde un filtre local ordinaire : une surface minimale écarte toujours les lignes trop petites", async () => {
    renderPage({ belowRange: true, minSqft: 100 });
    await waitFor(() => expect(state.fetchSearchResults).toHaveBeenCalled());
    // Les 3 lignes font 50 m² : le filtre de surface, lui, est rejoué localement.
    await waitFor(() => expect(screen.queryAllByRole("article")).toHaveLength(0));
  });
});
