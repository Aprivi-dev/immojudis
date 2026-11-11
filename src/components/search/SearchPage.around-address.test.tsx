// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";
import type { SalesSearchParams } from "@/lib/search/search-url-state";

vi.setConfig({ testTimeout: 15_000 });

/**
 * Recherche « autour d'une adresse » : la localisation suit l'adresse (`around-address-machine.ts`).
 * L'indication « localisation en cours » ne survit pas à l'effacement de l'adresse, et la réponse
 * d'une adresse abandonnée ne revient pas à l'écran.
 */
const state = vi.hoisted(() => ({
  fetchAccessPlan: vi.fn(),
  fetchSearchResults: vi.fn(),
  fetchSearchCount: vi.fn(),
  pepiteIds: vi.fn(),
  geocodeAddress: vi.fn(),
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

vi.mock("@/lib/geo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geo")>()),
  geocodeAddress: state.geocodeAddress,
}));

import { SearchPage } from "./SearchPage";

const rows = ["a", "b"].map((id) => ({
  id: `sale-${id}`,
  starting_price_eur: 80_000,
  sale_venue_type: "tribunal",
  sale_verification_status: "verified",
  city: `Ville ${id}`,
  department: "69",
  property_type: "apartment",
  sale_date: "2099-10-20T09:00:00Z",
  app_surface_m2: 50,
  occupancy_status: "free",
  latitude: 45.76,
  longitude: 4.83,
  media: [],
})) as unknown as AuctionSale[];

type Point = { lat: number; lng: number };

/** Une réponse du géocodeur que le test rend quand il le décide. */
function deferredPoint() {
  let resolve: (point: Point | null) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<Point | null>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function pageFor(client: QueryClient, search: SalesSearchParams) {
  return (
    <QueryClientProvider client={client}>
      <SearchPage search={search} serverSeeded={false} />
    </QueryClientProvider>
  );
}

const LOCATING = /localisation en cours/;

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
  state.fetchSearchResults.mockReset().mockResolvedValue(rows);
  state.fetchSearchCount.mockReset().mockResolvedValue(rows.length);
  state.pepiteIds.mockReset().mockResolvedValue(new Set());
  state.geocodeAddress.mockReset();
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

describe("/sales : localisation d'une recherche autour d'une adresse", () => {
  it("affiche la localisation en cours, puis l'enlève quand l'adresse est trouvée", async () => {
    const lyon = deferredPoint();
    state.geocodeAddress.mockReturnValue(lyon.promise);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(pageFor(client, { aroundAddress: "Lyon" }));

    await waitFor(() => expect(screen.getByText(LOCATING)).toBeTruthy());
    expect(state.geocodeAddress).toHaveBeenCalledWith("Lyon");

    await act(async () => lyon.resolve({ lat: 45.76, lng: 4.83 }));
    await waitFor(() => expect(screen.queryByText(LOCATING)).toBeNull());
  });

  it("n'affiche plus la localisation en cours quand l'adresse est effacée avant la réponse", async () => {
    const lyon = deferredPoint();
    state.geocodeAddress.mockReturnValue(lyon.promise);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(pageFor(client, { aroundAddress: "Lyon" }));
    await waitFor(() => expect(screen.getByText(LOCATING)).toBeTruthy());

    view.rerender(pageFor(client, {}));
    await waitFor(() => expect(screen.queryByText(LOCATING)).toBeNull());

    // La réponse tardive de l'adresse effacée ne ramène rien à l'écran.
    await act(async () => lyon.resolve({ lat: 45.76, lng: 4.83 }));
    expect(screen.queryByText(LOCATING)).toBeNull();
  });

  it("relocalise la nouvelle adresse et ignore la réponse tardive de la précédente", async () => {
    const lyon = deferredPoint();
    const lille = deferredPoint();
    state.geocodeAddress.mockImplementation((address: string) =>
      address === "Lyon" ? lyon.promise : lille.promise,
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(pageFor(client, { aroundAddress: "Lyon" }));
    await waitFor(() => expect(screen.getByText(LOCATING)).toBeTruthy());

    view.rerender(pageFor(client, { aroundAddress: "Lille" }));
    await waitFor(() => expect(state.geocodeAddress).toHaveBeenCalledWith("Lille"));

    // Lyon répond après coup : Lille est toujours en cours de localisation.
    await act(async () => lyon.resolve({ lat: 45.76, lng: 4.83 }));
    expect(screen.getByText(LOCATING)).toBeTruthy();

    await act(async () => lille.resolve({ lat: 50.63, lng: 3.06 }));
    await waitFor(() => expect(screen.queryByText(LOCATING)).toBeNull());
  });

  it("termine la localisation quand le géocodeur échoue", async () => {
    const lyon = deferredPoint();
    state.geocodeAddress.mockReturnValue(lyon.promise);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(pageFor(client, { aroundAddress: "Lyon" }));
    await waitFor(() => expect(screen.getByText(LOCATING)).toBeTruthy());

    await act(async () => lyon.reject(new Error("réseau coupé")));
    await waitFor(() => expect(screen.queryByText(LOCATING)).toBeNull());
  });
});
