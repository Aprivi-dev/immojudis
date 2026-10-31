// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";
import type { SalesSearchParams } from "@/lib/search/search-url-state";

vi.setConfig({ testTimeout: 15_000 });

/**
 * Carte de /sales : sur ordinateur, elle ne démarre (et ses points ne sont lus) que sur un geste fait
 * dans sa zone ; la zone de l'adresse est transmise à la carte, et le cadrage de départ ne réécrit
 * pas l'adresse.
 */
const state = vi.hoisted(() => ({
  desktop: true,
  fetchAccessPlan: vi.fn(),
  fetchSearchResults: vi.fn(),
  fetchSearchCount: vi.fn(),
  fetchSearchMapResults: vi.fn(),
  mapProps: null as null | Record<string, unknown>,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "user-1" },
    loading: false,
    session: null,
    authError: null,
  }),
}));
vi.mock("./MapPanel", () => ({
  MapPanel: (props: Record<string, unknown>) => {
    state.mapProps = props;
    return <div data-testid="map-panel" />;
  },
}));
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
  fetchSearchMapResults: state.fetchSearchMapResults,
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
  latitude: 45.7,
  longitude: 4.8,
  media: [],
})) as unknown as AuctionSale[];

const VIEWPORT = { north: 45.9, south: 45.6, east: 5.1, west: 4.6 };

function renderPage(search: SalesSearchParams) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SearchPage search={search} serverSeeded={false} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.desktop = true;
  state.mapProps = null;
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
  state.fetchSearchResults.mockReset().mockResolvedValue(rows);
  state.fetchSearchCount.mockReset().mockResolvedValue(rows.length);
  state.fetchSearchMapResults.mockReset().mockResolvedValue(rows);
  window.matchMedia = ((query: string) => ({
    matches: state.desktop && query.includes("min-width: 1024px"),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  window.history.replaceState(null, "", "/sales");
  vi.spyOn(window.history, "replaceState");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Laisse l'effet qui lit les gestes s'abonner, puis les files du navigateur se vider. */
async function flushPaint() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
}

describe("/sales sur ordinateur : la carte ne démarre que sur un geste dans sa zone", () => {
  it("ne démarre pas, et ne lit aucun point, au défilement de la page ni au survol de la zone", async () => {
    renderPage({});
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(rows.length));
    const zone = document.getElementById("sales-map")!;
    expect(zone).toBeTruthy();

    fireEvent.wheel(window);
    fireEvent.wheel(screen.getAllByRole("article")[0]);
    fireEvent.pointerDown(screen.getAllByRole("article")[0]);
    fireEvent.pointerEnter(zone, { pointerType: "mouse" });
    fireEvent.mouseOver(zone);
    await flushPaint();

    expect(screen.queryByTestId("map-panel")).toBeNull();
    expect(screen.getByTestId("map-preview")).toBeTruthy();
    expect(state.fetchSearchMapResults).not.toHaveBeenCalled();
  });

  it("démarre d'emblée quand l'adresse arrive avec ?map=true (demande explicite)", async () => {
    renderPage({ map: true });
    expect(await screen.findByTestId("map-panel")).toBeTruthy();
    expect(screen.queryByTestId("map-preview")).toBeNull();
    await waitFor(() => expect(state.fetchSearchMapResults).toHaveBeenCalled());
  });

  it("démarre à la molette sur la zone, puis lit les points de la carte", async () => {
    renderPage({});
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(rows.length));

    fireEvent.wheel(document.getElementById("sales-map")!);
    await flushPaint();

    expect(await screen.findByTestId("map-panel")).toBeTruthy();
    await waitFor(() => expect(state.fetchSearchMapResults).toHaveBeenCalled());
  });

  it("démarre au bouton « Afficher la carte »", async () => {
    renderPage({});
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(rows.length));
    fireEvent.click(screen.getByRole("button", { name: "Afficher la carte" }));
    expect(await screen.findByTestId("map-panel")).toBeTruthy();
  });
});

describe("/sales : cadrage de départ de la carte", () => {
  async function startMap(search: SalesSearchParams) {
    renderPage(search);
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(rows.length));
    fireEvent.click(screen.getByRole("button", { name: "Afficher la carte" }));
    await screen.findByTestId("map-panel");
  }

  it("transmet la zone de l'adresse à la carte", async () => {
    await startMap({ viewport: VIEWPORT, searchAsMove: true });
    expect(state.mapProps?.initialViewport).toEqual(VIEWPORT);
  });

  it("n'a pas de zone à transmettre quand l'adresse n'en porte pas", async () => {
    await startMap({});
    expect(state.mapProps?.initialViewport).toBeNull();
  });

  it("ne réécrit pas l'adresse pour le cadrage de départ, mais suit un déplacement de la personne", async () => {
    await startMap({ viewport: VIEWPORT, searchAsMove: true });
    const onViewportChange = state.mapProps!.onViewportChange as (change: unknown) => void;
    const before = vi.mocked(window.history.replaceState).mock.calls.length;
    const framing = {
      bounds: { north: 51.5, south: 41, east: 9.7, west: -5.6 },
      zoom: 5.7,
      initial: true,
    };
    await act(async () => {
      onViewportChange(framing);
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    expect(vi.mocked(window.history.replaceState).mock.calls.length).toBe(before);

    const moved = {
      bounds: { north: 44.9, south: 44.7, east: -0.5, west: -0.7 },
      zoom: 11,
      initial: false,
    };
    await act(async () => {
      onViewportChange(moved);
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    const urls = vi.mocked(window.history.replaceState).mock.calls.map(([, , url]) => String(url));
    expect(urls.at(-1)).toContain("bbox=-0.7%2C44.7%2C-0.5%2C44.9");
  });
});
