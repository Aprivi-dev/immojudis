// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";

vi.setConfig({ testTimeout: 15_000 });

/**
 * « Comparer » de la fiche visiteur : `/sales?comparer=<id>` ajoute la vente à la comparaison et
 * fait apparaître la barre de comparaison, puis le paramètre quitte l'adresse.
 */
const state = vi.hoisted(() => ({
  fetchSearchResults: vi.fn(),
  fetchSearchCount: vi.fn(),
  fetchComparedSale: vi.fn(),
  toastMessage: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: null, loading: false, session: null, authError: null }),
}));
vi.mock("./MapPanel", () => ({ MapPanel: () => <div data-testid="map-panel" /> }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/sales",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
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
vi.mock("@/lib/search/compared-sale", () => ({ fetchComparedSale: state.fetchComparedSale }));
vi.mock("@/lib/toast", () => ({
  toast: { message: state.toastMessage, success: vi.fn(), error: vi.fn() },
}));

import { SearchPage } from "./SearchPage";

const SALE_ID = "52d72de3-d795-492e-be50-58eb72d2eb47";

const listed = {
  id: "11111111-1111-4111-8111-111111111111",
  starting_price_eur: 80_000,
  sale_venue_type: "tribunal",
  sale_verification_status: "verified",
  city: "Bordeaux",
  department: "33",
  property_type: "apartment",
  sale_date: "2099-10-20T09:00:00Z",
  app_surface_m2: 50,
  media: [],
} as unknown as AuctionSale;

const fromSaleSheet = {
  ...listed,
  id: SALE_ID,
  city: "Aix-en-Provence",
  department: "13",
} as unknown as AuctionSale;

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SearchPage search={{ city: "Bordeaux" }} serverSeeded={false} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.fetchSearchResults.mockReset().mockResolvedValue([listed]);
  state.fetchSearchCount.mockReset().mockResolvedValue(1);
  state.fetchComparedSale.mockReset().mockResolvedValue(fromSaleSheet);
  state.toastMessage.mockReset();
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
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/sales");
});

describe("/sales?comparer=<id>", () => {
  it("ajoute la vente à la comparaison, montre la barre, et retire le paramètre de l'adresse", async () => {
    window.history.replaceState(null, "", `/sales?city=Bordeaux&comparer=${SALE_ID}#haut`);
    renderPage();

    // Le paramètre part tout de suite ; les autres critères et l'ancre restent.
    await waitFor(() => expect(window.location.search).toBe("?city=Bordeaux"));
    expect(window.location.hash).toBe("#haut");

    const bar = await screen.findByRole("region", { name: "Sélection à comparer" });
    expect(within(bar).getByRole("status").textContent).toBe("1/3 biens sélectionnés.");
    expect(within(bar).getByRole("button", { name: "Comparer (1)" })).toBeTruthy();
    // Sur mobile, la pastille de la barre basse prend le relais.
    expect(screen.getAllByRole("button", { name: "Comparer (1)" })).toHaveLength(2);
    expect(state.fetchComparedSale).toHaveBeenCalledTimes(1);
    expect(state.fetchComparedSale).toHaveBeenCalledWith(SALE_ID, {
      signedIn: false,
      discovery: false,
    });
    expect(state.toastMessage).toHaveBeenCalledWith(
      "Vente ajoutée à la comparaison. Choisissez jusqu’à 2 autres biens dans la liste.",
    );
  });

  it("ignore un identifiant qui n'a pas la forme d'une vente, et le retire aussi de l'adresse", async () => {
    window.history.replaceState(null, "", "/sales?city=Bordeaux&comparer=n-importe-quoi");
    renderPage();
    await screen.findAllByRole("article");
    await waitFor(() => expect(window.location.search).toBe("?city=Bordeaux"));
    expect(state.fetchComparedSale).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Sélection à comparer" })).toBeNull();
  });

  it("le dit quand la vente est introuvable, sans rien ajouter", async () => {
    state.fetchComparedSale.mockResolvedValue(null);
    window.history.replaceState(null, "", `/sales?comparer=${SALE_ID}`);
    renderPage();
    await waitFor(() =>
      expect(state.toastMessage).toHaveBeenCalledWith(
        "Cette vente n’a pas pu être ajoutée à la comparaison.",
      ),
    );
    expect(window.location.search).toBe("");
    expect(screen.queryByRole("region", { name: "Sélection à comparer" })).toBeNull();
  });
});
