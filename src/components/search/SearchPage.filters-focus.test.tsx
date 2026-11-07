// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";

vi.setConfig({ testTimeout: 15_000 });

/**
 * « Tous les filtres » (bureau) et « Filtres » (mobile) : la fenêtre se charge à la demande. Pendant
 * le chargement, le focus est sur la fenêtre d'attente ; à la fermeture (Échap compris), il doit
 * revenir au bouton qui l'a ouverte, pas tomber sur `body`.
 */
const state = vi.hoisted(() => ({
  fetchSearchResults: vi.fn(),
  fetchSearchCount: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: null, loading: false, session: null, authError: null }),
}));
vi.mock("./MapPanel", () => ({ MapPanel: () => <div data-testid="map-panel" /> }));
vi.mock("./DateRangeFields", () => ({ DateRangeFields: () => null }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/sales",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/client-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-api")>()),
  fetchSalesAiReviewProjections: vi.fn(async () => ({ projections: [] })),
  fetchNotificationPreferences: vi.fn(async () => ({ preferences: {} })),
}));
vi.mock("@/lib/search/search-service", () => ({
  fetchSearchResults: state.fetchSearchResults,
  fetchSearchCount: state.fetchSearchCount,
  fetchSearchMapResults: vi.fn(async () => []),
  fetchSearchPhotoMirrors: vi.fn(async () => new Map()),
}));

import { SearchPage } from "./SearchPage";

const rows = [
  {
    id: "sale-a",
    starting_price_eur: 80_000,
    sale_venue_type: "tribunal",
    sale_verification_status: "verified",
    city: "Bordeaux",
    department: "33",
    property_type: "apartment",
    sale_date: "2099-10-20T09:00:00Z",
    app_surface_m2: 50,
    media: [],
  },
] as unknown as AuctionSale[];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SearchPage search={{}} serverSeeded={false} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
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
  window.history.replaceState(null, "", "/sales");
});
afterEach(cleanup);

async function closeWithEscapeFrom(trigger: HTMLElement) {
  trigger.focus();
  fireEvent.click(trigger);
  // La vraie fenêtre (et non celle du chargement) : elle porte le bouton « Fermer ».
  await screen.findByRole("button", { name: "Fermer" });
  expect(screen.getByRole("dialog", { name: "Filtres avancés" })).toBeTruthy();
  expect(document.activeElement).not.toBe(trigger);
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
}

describe("/sales : fermeture de « Tous les filtres »", () => {
  it("Échap rend le focus au bouton « Tous les filtres » (bureau)", async () => {
    renderPage();
    await screen.findAllByRole("article");
    await closeWithEscapeFrom(screen.getByRole("button", { name: /^Tous les filtres/ }));
  });

  it("Échap rend le focus à la pastille « Filtres » (mobile)", async () => {
    renderPage();
    await screen.findAllByRole("article");
    const chips = screen.getByRole("group", { name: "Filtres rapides" });
    await closeWithEscapeFrom(within(chips).getByRole("button", { name: /^Filtres/ }));
  });
});
