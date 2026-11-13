// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";
import type { SalesSearchParams } from "@/lib/search/search-url-state";

vi.setConfig({ testTimeout: 15_000 });

/**
 * Alertes depuis /sales (écran mobile) : bouton « Alerte », limite gratuite rappelée dans la fenêtre
 * de création, et pastilles réservées aux comptes proposées (grisées) aux visiteurs.
 */
const state = vi.hoisted(() => ({
  auth: { user: null as null | { id: string }, loading: false },
  fetchAccessPlan: vi.fn(),
  fetchSearchResults: vi.fn(),
  fetchSearchCount: vi.fn(),
  getAlerts: vi.fn(),
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
  fetchSalesAiReviewProjections: vi.fn(async () => ({ projections: [] })),
  fetchNotificationPreferences: vi.fn(async () => ({ preferences: { alertEmailEnabled: false } })),
}));
vi.mock("@/lib/client-billing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-billing")>()),
  fetchAccessPlan: state.fetchAccessPlan,
}));
vi.mock("@/lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries")>()),
  getAlerts: state.getAlerts,
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

function renderPage(search: SalesSearchParams) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SearchPage search={search} serverSeeded={false} />
    </QueryClientProvider>,
  );
}

/** Le bouton compact de la rangée mobile (la version large, masquée par CSS, est aussi dans le DOM). */
async function findMobileAlertButton() {
  const buttons = await screen.findAllByRole("button", { name: "Créer une alerte" });
  return buttons.find((button) => button.textContent === "Alerte")!;
}

beforeEach(() => {
  state.auth = { user: null, loading: false };
  state.fetchAccessPlan.mockReset().mockResolvedValue({
    plan: {
      plan: "decouverte",
      hasAnalysisAccess: false,
      features: {
        salesStatistics: "locked",
        dpeExplorer: "locked",
        salesCsvExport: "locked",
        watchedZones: "limited",
        smartAlerts: "limited",
      },
    },
  });
  state.fetchSearchResults.mockReset().mockResolvedValue(rows);
  state.fetchSearchCount.mockReset().mockResolvedValue(rows.length);
  state.getAlerts.mockReset().mockResolvedValue([]);
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

describe("/sales visiteur : pastilles réservées aux comptes", () => {
  it("les montre grisées « avec un compte gratuit » ; un appui mène à l'inscription, filtres conservés", async () => {
    renderPage({ city: "Pau", maxPrice: 200_000 });
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(rows.length));

    const group = screen.getByRole("group", { name: "Filtres rapides" });
    const below = within(group).getByRole("link", { name: /Mise à prix sous le marché/ });
    expect(below.textContent).toContain("avec un compte gratuit");

    const href = new URL(below.getAttribute("href")!, "https://immojudis.test");
    expect(href.pathname).toBe("/login");
    expect(href.searchParams.get("mode")).toBe("investor");
    const back = new URL(href.searchParams.get("redirect")!, "https://immojudis.test");
    expect(back.pathname).toBe("/sales");
    expect(back.searchParams.get("city")).toBe("Pau");
    expect(back.searchParams.get("maxPrice")).toBe("200000");
    expect(back.searchParams.get("belowRange")).toBe("true");
    expect(back.searchParams.has("noPointsToVerify")).toBe(false);

    const other = within(group).getByRole("link", { name: /Sans point à vérifier/ });
    const otherBack = new URL(
      new URL(other.getAttribute("href")!, "https://immojudis.test").searchParams.get("redirect")!,
      "https://immojudis.test",
    );
    expect(otherBack.searchParams.get("noPointsToVerify")).toBe("true");
    expect(otherBack.searchParams.get("city")).toBe("Pau");
  });
});

describe("/sales compte gratuit : alerte", () => {
  beforeEach(() => {
    state.auth = { user: { id: "user-1" }, loading: false };
  });

  it("affiche « Alerte » sur mobile et la limite gratuite dans la fenêtre de création", async () => {
    renderPage({ city: "Pau" });
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(rows.length));
    // Rien n'est lu avant l'ouverture de la fenêtre.
    expect(state.getAlerts).not.toHaveBeenCalled();

    const button = await findMobileAlertButton();
    expect(button.textContent).toBe("Alerte");
    fireEvent.click(button);

    expect((await screen.findByTestId("free-alert-usage")).textContent).toBe(
      "1 alerte gratuite (0/1 utilisée)",
    );
    expect(state.getAlerts).toHaveBeenCalledWith("user-1");
  });

  it("compte seulement les alertes actives", async () => {
    state.getAlerts.mockResolvedValue([
      { id: "a1", is_active: true },
      { id: "a2", is_active: false },
    ]);
    renderPage({ city: "Pau" });
    fireEvent.click(await findMobileAlertButton());
    await waitFor(() =>
      expect(screen.getByTestId("free-alert-usage").textContent).toContain(
        "1 alerte gratuite (1/1 utilisée)",
      ),
    );
  });

  it("propose les deux pastilles en bascules, sans lien d'inscription", async () => {
    renderPage({});
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(rows.length));
    expect(screen.getByRole("button", { name: "Sans point à vérifier" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /avec un compte gratuit/ })).toBeNull();
  });
});
