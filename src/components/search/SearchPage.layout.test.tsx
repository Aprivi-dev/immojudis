// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";
import type { SalesSearchParams } from "@/lib/search/search-url-state";

vi.setConfig({ testTimeout: 15_000 });

/**
 * Premier écran de /sales : une seule rangée de réglages avant la première annonce (tri et type de
 * vente joints), les liens d'aide au pied de la liste, et, sans résultat, rien d'autre que l'état vide.
 */
const state = vi.hoisted(() => ({
  fetchAccessPlan: vi.fn(),
  fetchSearchResults: vi.fn(),
  fetchSearchCount: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: null, loading: false, session: null, authError: null }),
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
}));
vi.mock("@/lib/search/search-service", () => ({
  fetchSearchResults: state.fetchSearchResults,
  fetchSearchCount: state.fetchSearchCount,
  fetchSearchMapResults: vi.fn(async () => []),
  fetchSearchPhotoMirrors: vi.fn(async () => new Map()),
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
  state.fetchAccessPlan.mockReset();
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

const before = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("/sales : avant la première annonce", () => {
  it("suit la maquette : titre, barre de filtres, pastilles de type de vente, barre de liste, cartes", async () => {
    renderPage({});
    const cards = await screen.findAllByRole("article");

    const title = screen.getByRole("heading", { level: 1 });
    await waitFor(() =>
      expect(title.textContent).toMatch(/^3 ventes immobilières aux enchères à venir/),
    );
    const place = screen.getByRole("textbox", { name: "Ville, département ou région" });
    const types = screen.getByRole("group", { name: "Type de vente" });
    const sort = screen.getByRole("combobox", { name: "Tri" });
    expect(within(types).getByRole("button", { name: "Au tribunal" })).toBeTruthy();
    expect(within(types).getByRole("link", { name: "Quelle différence ?" })).toBeTruthy();
    expect(before(title, place)).toBe(true);
    expect(before(place, types)).toBe(true);
    expect(before(types, sort)).toBe(true);
    expect(before(sort, cards[0])).toBe(true);
    // Le type de vente n'est plus une liste déroulante jointe au tri.
    expect(screen.queryByRole("combobox", { name: "Type de vente" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Tri et type de vente" })).toBeNull();
  });

  it("met l'export et l'alerte à droite du titre, avant la barre de filtres", async () => {
    renderPage({});
    await screen.findAllByRole("article");
    const place = screen.getByRole("textbox", { name: "Ville, département ou région" });
    const csv = screen.getByRole("button", { name: "Exporter en CSV" });
    const alert = screen.getByRole("button", { name: "Créer une alerte sur cette recherche" });
    expect(before(csv, place)).toBe(true);
    expect(before(alert, place)).toBe(true);
  });

  it("n'a plus les trois liens d'aide avant les annonces : ils sont au pied de la liste", async () => {
    renderPage({});
    const cards = await screen.findAllByRole("article");
    const help = screen.getByRole("region", { name: "Aide à la lecture des résultats" });

    expect(before(cards.at(-1)!, help)).toBe(true);
    const types = within(help).getByRole("link", {
      name: "Quelle différence entre les types de vente ?",
    });
    expect(types.getAttribute("href")).toBe("/ventes-immobilieres-judiciaires#differences");
    expect(within(help).getByRole("link", { name: "Audiences de la semaine" })).toBeTruthy();
    expect(within(help).getByText("Comment sont classées les annonces ?")).toBeTruthy();
    // Un seul exemplaire de chaque, et rien devant la première annonce.
    expect(screen.getAllByText("Comment sont classées les annonces ?")).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: "Audiences de la semaine" })).toHaveLength(1);
    expect(before(cards[0], screen.getByRole("link", { name: "Audiences de la semaine" }))).toBe(
      true,
    );
  });

  it("le type de vente choisi dans les pastilles s'écrit dans l'adresse", async () => {
    renderPage({});
    await screen.findAllByRole("article");
    fireEvent.click(
      within(screen.getByRole("group", { name: "Type de vente" })).getByRole("button", {
        name: "Chez le notaire",
      }),
    );
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get("saleType")).toBe("notary"),
    );
  });

  it("garde le tri en liste déroulante, dans le même contrôle", async () => {
    renderPage({});
    await screen.findAllByRole("article");
    const sort = screen.getByRole("combobox", { name: "Tri" }) as HTMLSelectElement;
    fireEvent.change(sort, { target: { value: "price_asc" } });
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get("sort")).toBe("price_asc"),
    );
  });
});

describe("/sales sans résultat", () => {
  beforeEach(() => {
    state.fetchSearchResults.mockResolvedValue([]);
    state.fetchSearchCount.mockResolvedValue(0);
  });

  it("ne montre que le titre, l'état vide et ses actions : ni réglages ni liens d'aide", async () => {
    renderPage({ city: "Pau", saleType: "notary" });
    expect(await screen.findByRole("heading", { name: "Aucune vente trouvée" })).toBeTruthy();

    expect(screen.queryByRole("group", { name: "Tri et type de vente" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Tri" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Aide à la lecture des résultats" })).toBeNull();
    expect(screen.queryByText("Comment sont classées les annonces ?")).toBeNull();
    expect(screen.queryByRole("link", { name: "Audiences de la semaine" })).toBeNull();
    // Les actions de l'état vide restent : retirer un critère, effacer, élargir.
    expect(
      screen.getByRole("button", { name: "Retirer le critère : Chez le notaire" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Effacer les filtres" }).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByRole("button", { name: "Voir toute la France" })).toBeTruthy();
  });

  it("retirer le critère du type de vente depuis l'état vide relance la recherche", async () => {
    renderPage({ saleType: "notary" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Retirer le critère : Chez le notaire" }),
    );
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).has("saleType")).toBe(false),
    );
  });

  it("pendant le chargement, les réglages restent là (rien ne saute avant la réponse)", async () => {
    state.fetchSearchCount.mockReturnValue(new Promise(() => undefined));
    state.fetchSearchResults.mockReturnValue(new Promise(() => undefined));
    renderPage({ city: "Pau" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByRole("combobox", { name: "Tri" })).toBeTruthy();
    // Aucun chiffre n'est inventé en attendant le total : le titre reste une phrase sans nombre.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Ventes immobilières aux enchères à Pau",
    );
  });

  it("dit « Aucune vente » dans le titre quand le total est nul", async () => {
    renderPage({ city: "Pau" });
    await screen.findByRole("heading", { name: "Aucune vente trouvée" });
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
        "Aucune vente immobilière aux enchères à venir à Pau.",
      ),
    );
  });
});

describe("/sales : « dont M cette semaine »", () => {
  it("compte la même recherche bornée aux sept prochains jours et l'écrit dans le titre", async () => {
    state.fetchSearchCount.mockImplementation(async ({ search }: { search: SalesSearchParams }) =>
      search.minSaleDate ? 2 : 3,
    );
    renderPage({ city: "Pau" });
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
        "3 ventes immobilières aux enchères à venir à Pau, dont 2 cette semaine.",
      ),
    );
    const weekCall = state.fetchSearchCount.mock.calls.find(([args]) => args.search.minSaleDate);
    expect(weekCall![0].search).toMatchObject({ city: "Pau" });
    expect(weekCall![0].search.maxSaleDate > weekCall![0].search.minSaleDate).toBe(true);
  });

  it("ne compte rien de plus pour une recherche à filtre lu sur les lignes", async () => {
    renderPage({ belowRange: true });
    await screen.findAllByRole("article");
    await waitFor(() => expect(state.fetchSearchCount).toHaveBeenCalled());
    expect(state.fetchSearchCount.mock.calls.every(([args]) => !args.search.minSaleDate)).toBe(
      true,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).not.toContain("semaine");
  });
});
