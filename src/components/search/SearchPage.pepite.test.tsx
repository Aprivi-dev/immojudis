// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";

const state = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  fetchSearchResults: vi.fn(),
  fetchSearchCount: vi.fn(),
  pepiteIds: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: null, loading: false, session: null, authError: null }),
}));
vi.mock("./MapPanel", () => ({ MapPanel: () => <div data-testid="map-panel" /> }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/sales",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: () => {
    const search = useSyncExternalStore(
      (listener) => {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
      () => window.location.search,
      () => "",
    );
    return new URLSearchParams(search);
  },
}));
vi.mock("@/lib/search/search-service", () => ({
  fetchSearchResults: state.fetchSearchResults,
  fetchSearchCount: state.fetchSearchCount,
  fetchSearchMapResults: vi.fn(async () => []),
}));
vi.mock("@/lib/search/pepite-filter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/search/pepite-filter")>()),
  fetchPepiteSaleIds: state.pepiteIds,
}));

import { SalesPage } from "@/app/sales/sales-page";
import {
  ANONYMOUS_PREVIEW_SCOPE,
  salesSearchCountQueryKey,
  salesSearchQueryKey,
} from "@/lib/search/catalog-placeholder";

const sales = Array.from({ length: 6 }, (_, index) => ({
  id: `sale-${index + 1}`,
  starting_price_eur: 50_000 + index * 1000,
  sale_venue_type: "tribunal",
  sale_verification_status: "verified",
  city: `Ville ${index + 1}`,
  department: "93",
  property_type: "apartment",
  sale_date: "2099-10-20T09:00:00Z",
  app_surface_m2: 50,
  media: [],
})) as unknown as AuctionSale[];

function renderSales(url: string) {
  window.history.replaceState(null, "", url);
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(salesSearchQueryKey("[]", ANONYMOUS_PREVIEW_SCOPE), sales);
  client.setQueryData(salesSearchCountQueryKey("[]", ANONYMOUS_PREVIEW_SCOPE), 6);
  return render(
    <QueryClientProvider client={client}>
      <SalesPage serverSeeded />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.fetchSearchResults.mockReset().mockResolvedValue(sales);
  state.fetchSearchCount.mockReset().mockResolvedValue(6);
  state.pepiteIds.mockReset().mockResolvedValue(new Set());
  const replaceState = window.history.replaceState.bind(window.history);
  vi.spyOn(window.history, "replaceState").mockImplementation((...args) => {
    replaceState(...args);
    act(() => state.listeners.forEach((listener) => listener()));
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("/sales : repère « Pépite » tant que le mode n'est pas « on » (liste vide)", () => {
  it("ne change rien de visible : ni pastille, ni filtre, ni note de classement", async () => {
    renderSales("/sales");
    await waitFor(() => expect(state.pepiteIds).toHaveBeenCalled());
    expect(screen.getAllByRole("article")).toHaveLength(sales.length);
    expect(screen.queryByTestId("pepite-badge")).toBeNull();
    expect(screen.queryByRole("button", { name: "Pépites seulement" })).toBeNull();
    fireEvent.click(screen.getByText("Comment sont classées les annonces ?"));
    expect(document.body.textContent).not.toMatch(/pépite/i);
  });

  it("ne lit la liste qu'une fois pour toute la page, pas une fois par carte", async () => {
    renderSales("/sales");
    await waitFor(() => expect(state.pepiteIds).toHaveBeenCalled());
    expect(state.pepiteIds).toHaveBeenCalledTimes(1);
  });
});

describe("/sales : repère « Pépite » en mode « on »", () => {
  beforeEach(() => state.pepiteIds.mockResolvedValue(new Set(["sale-2", "sale-5"])));

  it("pose la pastille sur les seules pépites de la page", async () => {
    renderSales("/sales");
    await waitFor(() => expect(screen.getAllByTestId("pepite-badge")).toHaveLength(2));
    const cards = screen.getAllByRole("article");
    expect(within(cards[1]).getByTestId("pepite-badge")).toBeTruthy();
    expect(within(cards[0]).queryByTestId("pepite-badge")).toBeNull();
    expect(state.pepiteIds).toHaveBeenCalledTimes(1);
  });

  it("propose « Pépites seulement » en première pastille, ouverte à un visiteur, et l'écrit dans l'adresse", async () => {
    renderSales("/sales");
    const chip = await screen.findByRole("button", { name: "Pépites seulement" });
    const group = screen.getByRole("group", { name: "Filtres rapides" });
    expect(group.firstElementChild).toBe(chip);
    fireEvent.click(chip);
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get("pepite")).toBe("true"),
    );
  });

  it("ajoute la note de classement : le repère ne change aucun tri", async () => {
    renderSales("/sales");
    await screen.findByRole("button", { name: "Pépites seulement" });
    fireEvent.click(screen.getByText("Comment sont classées les annonces ?"));
    expect(document.body.textContent).toContain(
      "Le repère « Pépite » ne change ni l’ordre par défaut ni les autres tris.",
    );
  });
});
