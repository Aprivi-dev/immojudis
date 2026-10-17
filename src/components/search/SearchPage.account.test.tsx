// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";

/**
 * Parcours connecté de /sales : la liste publique servie dans le HTML reste à l'écran pendant la
 * vérification du compte et le chargement de la liste connectée (pas de squelette), puis elle est
 * remplacée. Aucune donnée connectée n'est lue ni affichée avant la réponse du serveur sur les
 * droits.
 */
const state = vi.hoisted(() => ({
  auth: { user: null as null | { id: string }, loading: true },
  fetchAccessPlan: vi.fn(),
  fetchSearchResults: vi.fn(),
  fetchSearchCount: vi.fn(),
  fetchSearchPhotoMirrors: vi.fn(),
  fetchSalesAiReviewProjections: vi.fn(),
  fetchNotificationPreferences: vi.fn(),
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
  fetchAccessPlan: state.fetchAccessPlan,
  fetchSalesAiReviewProjections: state.fetchSalesAiReviewProjections,
  fetchNotificationPreferences: state.fetchNotificationPreferences,
}));
vi.mock("@/lib/search/search-service", () => ({
  fetchSearchResults: state.fetchSearchResults,
  fetchSearchCount: state.fetchSearchCount,
  fetchSearchMapResults: vi.fn(async () => []),
  fetchSearchPhotoMirrors: state.fetchSearchPhotoMirrors,
}));

import { SearchPage } from "./SearchPage";
import {
  ANONYMOUS_PREVIEW_SCOPE,
  salesSearchCountQueryKey,
  salesSearchQueryKey,
} from "@/lib/search/catalog-placeholder";
import { FAVORITE_ANONYMOUS_TITLE } from "@/components/favorite-feedback";

const PHOTO = "https://www.licitor.com/photos/maison.jpg";

function publicSale(index: number) {
  return {
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    starting_price_eur: 50_000 + index * 1000,
    sale_venue_type: "tribunal",
    sale_verification_status: "verified",
    city: "Romainville",
    department: "93",
    property_type: "apartment",
    sale_date: "2099-10-20T09:00:00Z",
    app_surface_m2: 50,
    media: [],
  };
}
const publicSales = Array.from({ length: 24 }, (_, index) =>
  publicSale(index),
) as unknown as AuctionSale[];

const connectedSales = [
  {
    ...publicSale(100),
    city: "Lyon",
    // Champ réservé : il n'a rien à faire à l'écran avant la vérification des droits.
    lawyer_contact: "CONTACT-RESERVE-AVOCAT",
    media: [{ type: "image", url: PHOTO }],
  },
  { ...publicSale(101), city: "Lyon", lawyer_contact: "CONTACT-RESERVE-AVOCAT-2" },
] as unknown as AuctionSale[];

const analysisPlan = {
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
};

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function seededClient(seed = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seed) {
    client.setQueryData(salesSearchQueryKey("[]", ANONYMOUS_PREVIEW_SCOPE), publicSales);
    client.setQueryData(salesSearchCountQueryKey("[]", ANONYMOUS_PREVIEW_SCOPE), 2276);
  }
  return client;
}

function page(client: QueryClient, serverSeeded = true) {
  return (
    <QueryClientProvider client={client}>
      <SearchPage search={{}} serverSeeded={serverSeeded} />
    </QueryClientProvider>
  );
}

const cards = () => screen.queryAllByRole("article");
/** Cartes squelettes de la liste (8 quand la liste se charge sans rien à montrer). */
const skeletonShown = () =>
  document.querySelectorAll('[aria-hidden="true"] > .animate-pulse').length > 0;
/** Le compteur de l'en-tête annonce « Recherche en cours… » tant que le total n'est pas connu. */
const countLoading = () => screen.queryByText("Recherche en cours…") !== null;

beforeEach(() => {
  state.auth = { user: null, loading: true };
  state.fetchAccessPlan.mockReset();
  state.fetchSearchResults.mockReset();
  state.fetchSearchCount.mockReset();
  state.fetchSearchPhotoMirrors.mockReset().mockResolvedValue(new Map());
  state.fetchSalesAiReviewProjections.mockReset().mockResolvedValue({ projections: [] });
  state.fetchNotificationPreferences
    .mockReset()
    .mockResolvedValue({ preferences: { alertEmailEnabled: false } });
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
  vi.unstubAllEnvs();
});

describe("/sales : compte reconnu avec une liste publique déjà affichée", () => {
  it("garde la liste publique, sans squelette, jusqu'à l'arrivée de la liste connectée qui la remplace", async () => {
    const plan = deferred<typeof analysisPlan>();
    const list = deferred<AuctionSale[]>();
    const count = deferred<number>();
    state.fetchAccessPlan.mockReturnValue(plan.promise);
    state.fetchSearchResults.mockReturnValue(list.promise);
    state.fetchSearchCount.mockReturnValue(count.promise);
    const client = seededClient();

    // 1. Le HTML : visiteur anonyme, session en cours de restauration.
    const view = render(page(client));
    expect(cards()).toHaveLength(24);

    // 2. Le compte est reconnu, ses droits sont en cours de vérification côté serveur.
    state.auth = { user: { id: "user-1" }, loading: false };
    view.rerender(page(client));
    expect(cards()).toHaveLength(24);
    expect(skeletonShown()).toBe(false);
    expect(screen.getByText(/2\s?276 annonces/)).toBeTruthy();
    // La liste publique reste en mode aperçu (comme dans le HTML) et rien de connecté n'est lu.
    expect(screen.getAllByRole("button", { name: /favoris/i })[0]!.getAttribute("title")).toBe(
      FAVORITE_ANONYMOUS_TITLE,
    );
    expect(state.fetchAccessPlan).toHaveBeenCalledTimes(1);
    expect(state.fetchSearchResults).not.toHaveBeenCalled();
    expect(state.fetchSearchCount).not.toHaveBeenCalled();
    expect(state.fetchSalesAiReviewProjections).not.toHaveBeenCalled();

    // 3. Les droits arrivent : la liste et le décompte partent ensemble, la liste publique reste.
    await act(async () => plan.resolve(analysisPlan));
    await waitFor(() => expect(state.fetchSearchResults).toHaveBeenCalledTimes(1));
    expect(state.fetchSearchCount).toHaveBeenCalledTimes(1);
    expect(state.fetchSearchResults.mock.calls[0]![0]).toMatchObject({
      preview: false,
      discovery: false,
    });
    expect(cards()).toHaveLength(24);
    expect(skeletonShown()).toBe(false);
    expect(state.fetchSalesAiReviewProjections).not.toHaveBeenCalled();

    // 4. La liste connectée arrive (le décompte, lui, tarde) : elle remplace la liste publique.
    await act(async () => list.resolve(connectedSales));
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(screen.getAllByText(/Lyon/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Romainville/)).toBeNull();
    // Le décompte ne retarde pas la liste : il s'annonce à part.
    expect(skeletonShown()).toBe(false);
    expect(countLoading()).toBe(true);
    await act(async () => count.resolve(2));
    await waitFor(() => expect(countLoading()).toBe(false));
    expect(screen.getByText(/2 annonces/)).toBeTruthy();
  });

  it("n'affiche ni ne lit rien de réservé avant la réponse du serveur sur les droits", async () => {
    state.fetchAccessPlan.mockReturnValue(new Promise(() => undefined));
    state.fetchSearchResults.mockResolvedValue(connectedSales);
    state.fetchSearchCount.mockResolvedValue(2);
    const client = seededClient();
    const view = render(page(client));
    state.auth = { user: { id: "user-1" }, loading: false };
    view.rerender(page(client));

    await act(async () => undefined);

    expect(document.body.textContent).not.toContain("CONTACT-RESERVE-AVOCAT");
    expect(state.fetchSearchResults).not.toHaveBeenCalled();
    expect(state.fetchSearchCount).not.toHaveBeenCalled();
    expect(state.fetchSalesAiReviewProjections).not.toHaveBeenCalled();
    expect(cards()).toHaveLength(24);
  });

  it("n'affiche pas de champ réservé dans la liste publique conservée", () => {
    const client = seededClient();
    state.auth = { user: { id: "user-1" }, loading: false };
    state.fetchAccessPlan.mockReturnValue(new Promise(() => undefined));

    render(page(client));

    const text = document.body.textContent ?? "";
    expect(text).toContain("Romainville");
    expect(text).not.toContain("CONTACT-RESERVE");
    for (const sale of publicSales) {
      for (const field of ["lawyer_contact", "investment_score", "address", "documents"]) {
        expect(sale).not.toHaveProperty(field);
      }
    }
  });

  it("garde le squelette quand le serveur n'a servi aucune liste publique", async () => {
    state.fetchAccessPlan.mockReturnValue(new Promise(() => undefined));
    const client = seededClient(false);
    const view = render(page(client, false));
    state.auth = { user: { id: "user-1" }, loading: false };
    view.rerender(page(client, false));

    expect(cards()).toHaveLength(0);
    expect(skeletonShown()).toBe(true);
  });

  it("une liste connectée en erreur ne reste pas masquée par la liste publique", async () => {
    state.fetchAccessPlan.mockResolvedValue(analysisPlan);
    state.fetchSearchResults.mockRejectedValue(new Error("Catalogue indisponible"));
    state.fetchSearchCount.mockResolvedValue(0);
    const client = seededClient();
    const view = render(page(client));
    state.auth = { user: { id: "user-1" }, loading: false };
    view.rerender(page(client));

    await waitFor(() => expect(cards()).toHaveLength(0));
  });
});

describe("/sales : copies de photos de la liste connectée", () => {
  it("la liste s'affiche sans attendre les copies, qui sont posées ensuite", async () => {
    vi.stubEnv("NEXT_PUBLIC_PHOTO_MIRROR", "on");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ci.supabase.co");
    const mirrors = deferred<Map<string, unknown>>();
    state.fetchAccessPlan.mockResolvedValue(analysisPlan);
    state.fetchSearchResults.mockResolvedValue(connectedSales);
    state.fetchSearchCount.mockResolvedValue(2);
    state.fetchSearchPhotoMirrors.mockReturnValue(mirrors.promise);
    state.auth = { user: { id: "user-1" }, loading: false };

    const { container } = render(page(seededClient(false), false));

    await waitFor(() => expect(cards()).toHaveLength(2));
    await waitFor(() => expect(state.fetchSearchPhotoMirrors).toHaveBeenCalledTimes(1));
    // Les copies sont demandées pour les ventes lues, et la liste est déjà à l'écran.
    expect(state.fetchSearchPhotoMirrors.mock.calls[0]![0]).toHaveLength(2);
    expect(container.innerHTML).not.toContain("sale-photos/");
    expect(state.fetchSearchResults.mock.calls[0]![0]).toMatchObject({ withMirrors: false });

    await act(async () =>
      mirrors.resolve(
        new Map([
          [
            PHOTO,
            { path640: "s/abc-640.webp", path1600: "s/abc-1600.webp", width: 1600, height: 1200 },
          ],
        ]),
      ),
    );
    await waitFor(() => expect(container.innerHTML).toContain("sale-photos/s/abc-640.webp"));
  });
});
