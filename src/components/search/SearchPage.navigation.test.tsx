// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { AuctionSale } from "@/lib/types";

/**
 * Navigation de /sales : historique du navigateur (Retour), liens d'évitement, vérification du
 * compte, rafraîchissements, adresse nettoyée et page hors bornes.
 */
const state = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  auth: { user: null as null | { id: string }, loading: false },
  fetchSearchResults: vi.fn(),
  fetchSearchCount: vi.fn(),
  fetchAccessPlan: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() },
  toast: { message: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ ...state.auth, session: null, authError: null }),
}));
vi.mock("./MapPanel", () => ({ MapPanel: () => <div data-testid="map-panel" /> }));
vi.mock("sonner", () => ({ toast: state.toast }));
vi.mock("@/integrations/supabase/lazy", () => ({
  getSupabase: async () => {
    throw new Error("Aucun appel Supabase attendu dans ce test");
  },
  hasSupabaseAuthHint: () => false,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/sales",
  useRouter: () => state.router,
  // Comme Next : `history.pushState` et `replaceState` mettent `useSearchParams` à jour.
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
vi.mock("@/lib/client-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-api")>()),
  fetchAccessPlan: state.fetchAccessPlan,
  fetchNotificationPreferences: vi.fn(async () => ({ preferences: {} })),
  fetchSalesAiReviewProjections: vi.fn(async () => ({ projections: [] })),
}));
vi.mock("@/lib/search/search-service", () => ({
  fetchSearchResults: state.fetchSearchResults,
  fetchSearchCount: state.fetchSearchCount,
  fetchSearchMapResults: vi.fn(async () => []),
  fetchSearchPhotoMirrors: vi.fn(async () => new Map()),
}));

import { SalesPage } from "@/app/sales/sales-page";
import {
  ANONYMOUS_PREVIEW_SCOPE,
  salesSearchCountQueryKey,
  salesSearchQueryKey,
} from "@/lib/search/catalog-placeholder";
import { SearchRejectedError, retrySearch } from "@/lib/search/search-errors";

const sales = Array.from({ length: 24 }, (_, index) => ({
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

function setViewport(desktop: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: desktop,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function renderSales(
  url: string,
  { desktop = true, client }: { desktop?: boolean; client?: QueryClient } = {},
) {
  window.history.replaceState(null, "", url);
  setViewport(desktop);
  const queryClient =
    client ?? new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
  queryClient.setQueryData(salesSearchQueryKey("[]", ANONYMOUS_PREVIEW_SCOPE), sales);
  queryClient.setQueryData(salesSearchCountQueryKey("[]", ANONYMOUS_PREVIEW_SCOPE), 100);
  return render(
    <QueryClientProvider client={queryClient}>
      <SalesPage serverSeeded />
    </QueryClientProvider>,
  );
}

const pushStateCalls = () =>
  (window.history.pushState as unknown as Mock).mock.calls.map(([, , url]) => String(url));
const replaceStateCalls = () =>
  (window.history.replaceState as unknown as Mock).mock.calls.map(([, , url]) => String(url));

beforeEach(() => {
  // jsdom ne fait ni défilement ni mise au point d'un conteneur : la page les demande à un changement de page.
  Element.prototype.scrollIntoView = vi.fn();
  state.auth = { user: null, loading: false };
  state.fetchSearchResults.mockReset().mockResolvedValue(sales);
  state.fetchSearchCount.mockReset().mockResolvedValue(100);
  state.fetchAccessPlan.mockReset();
  state.router.push.mockReset();
  state.toast.message.mockReset();
  for (const method of ["pushState", "replaceState"] as const) {
    const original = window.history[method].bind(window.history);
    vi.spyOn(window.history, method).mockImplementation((...args) => {
      original(...args);
      act(() => state.listeners.forEach((listener) => listener()));
    });
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("/sales : « Retour » défait la carte, la page et les filtres validés", () => {
  it("ajoute une entrée d'historique à chaque changement de page (suivante, numéro)", async () => {
    renderSales("/sales");
    fireEvent.click(screen.getByRole("link", { name: "Page suivante" }));
    expect(pushStateCalls()).toEqual(["/sales?page=2"]);

    // La page 2 arrive : la pagination ne bloque plus les clics.
    await waitFor(() => expect(screen.queryByTestId("results-refreshing")).toBeNull());
    fireEvent.click(screen.getByRole("link", { name: "Page 4" }));
    expect(pushStateCalls().at(-1)).toBe("/sales?page=4");
    expect(replaceStateCalls().some((url) => url.includes("page="))).toBe(false);
  });

  it("ajoute une entrée pour un tri choisi et pour un type de vente choisi", async () => {
    renderSales("/sales");
    fireEvent.change(screen.getByRole("combobox", { name: "Tri" }), {
      target: { value: "price_asc" },
    });
    expect(pushStateCalls()).toEqual(["/sales?sort=price_asc"]);

    fireEvent.click(screen.getByRole("button", { name: "Au tribunal" }));
    await waitFor(() => expect(pushStateCalls().at(-1)).toContain("saleType=tribunal"), {
      timeout: 3000,
    });
  });

  it("remplace l'adresse pendant la frappe d'un montant, sans empiler d'entrée", async () => {
    renderSales("/sales");
    fireEvent.change(screen.getByRole("textbox", { name: "Prix maximum" }), {
      target: { value: "150000" },
    });
    await waitFor(() => expect(replaceStateCalls()).toContain("/sales?maxPrice=150000"), {
      timeout: 3000,
    });
    expect(pushStateCalls()).toEqual([]);
  });

  it("ouvre la carte mobile par une entrée d'historique et la ferme par « Retour »", async () => {
    renderSales("/sales", { desktop: false });
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);

    fireEvent.click(screen.getByRole("button", { name: "Carte" }));
    expect(pushStateCalls()).toEqual(["/sales?map=true"]);
    expect(await screen.findByRole("button", { name: "Liste" })).toBeTruthy();

    // Le bouton « Liste » défait l'entrée ajoutée au lieu d'en empiler une.
    fireEvent.click(screen.getByRole("button", { name: "Liste" }));
    expect(back).toHaveBeenCalledTimes(1);
    expect(replaceStateCalls().some((url) => !url.includes("map=true") && url !== "/sales")).toBe(
      false,
    );
  });

  it("referme une carte ouverte par son adresse sans quitter la page", async () => {
    renderSales("/sales?map=true", { desktop: false });
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    fireEvent.click(await screen.findByRole("button", { name: "Liste" }));
    expect(back).not.toHaveBeenCalled();
    expect(replaceStateCalls().at(-1)).toBe("/sales");
  });

  it("rouvre la liste quand « Retour » enlève ?map=true de l'adresse", async () => {
    renderSales("/sales", { desktop: false });
    fireEvent.click(screen.getByRole("button", { name: "Carte" }));
    expect(await screen.findByRole("button", { name: "Liste" })).toBeTruthy();
    act(() => {
      window.history.replaceState(null, "", "/sales");
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Liste" })).toBeNull());
  });
});

describe("/sales : liens d'évitement", () => {
  it("propose résultats, pagination et carte, dans cet ordre, vers des cibles qui existent", () => {
    renderSales("/sales");
    const links = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("href")?.startsWith("#"));
    expect(links.map((link) => link.textContent)).toEqual([
      "Aller aux résultats",
      "Aller à la pagination",
      "Aller à la carte",
    ]);
    for (const link of links) {
      const id = link.getAttribute("href")!.slice(1);
      expect(document.getElementById(id), id).not.toBeNull();
    }
  });

  it("ne propose pas la carte du bureau sur mobile", () => {
    renderSales("/sales", { desktop: false });
    expect(screen.queryByRole("link", { name: "Aller à la carte" })).toBeNull();
    expect(screen.getByRole("link", { name: "Aller à la pagination" })).toBeTruthy();
  });
});

describe("/sales : compte en cours de vérification", () => {
  it("n'envoie pas vers la connexion et le dit, pour « Créer une alerte »", () => {
    state.auth = { user: null, loading: true };
    renderSales("/sales");
    fireEvent.click(screen.getByRole("button", { name: "Créer une alerte" }));
    expect(state.toast.message).toHaveBeenCalledWith(
      "Vérification de votre compte en cours. Réessayez dans un instant.",
    );
    expect(state.router.push).not.toHaveBeenCalled();
  });

  it("n'envoie pas vers la connexion et le dit, pour « Exporter en CSV »", () => {
    state.auth = { user: null, loading: true };
    renderSales("/sales");
    fireEvent.click(screen.getByRole("button", { name: "Exporter en CSV" }));
    expect(state.toast.message).toHaveBeenCalledWith(
      "Vérification de votre compte en cours. Réessayez dans un instant.",
    );
    expect(state.router.push).not.toHaveBeenCalled();
  });

  it("envoie le visiteur sans compte vers la connexion, une fois la vérification terminée", () => {
    renderSales("/sales");
    fireEvent.click(screen.getByRole("button", { name: "Exporter en CSV" }));
    expect(state.toast.message).not.toHaveBeenCalled();
    expect(state.router.push).toHaveBeenCalledWith(expect.stringContaining("/login?"));
  });
});

describe("/sales : rafraîchissements", () => {
  it("ne relit pas la liste en tâche de fond pour un visiteur anonyme", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderSales("/sales");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(state.fetchSearchResults).not.toHaveBeenCalled();
    expect(state.fetchSearchCount).not.toHaveBeenCalled();
  });

  it("relit la liste d'un compte connecté toutes les 60 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    state.auth = { user: { id: "user-a" }, loading: false };
    state.fetchAccessPlan.mockResolvedValue({
      plan: { plan: "analyse", hasAnalysisAccess: true, features: {} },
    });
    renderSales("/sales");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const initial = state.fetchSearchResults.mock.calls.length;
    expect(initial).toBeGreaterThan(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(state.fetchSearchResults.mock.calls.length).toBeGreaterThan(initial);
  });

  it("n'ajoute aucun texte à la liste pendant un changement de page : un indicateur dans le compteur", async () => {
    let finish!: (value: AuctionSale[]) => void;
    renderSales("/sales");
    state.fetchSearchResults.mockReturnValue(
      new Promise<AuctionSale[]>((resolve) => {
        finish = resolve;
      }),
    );
    fireEvent.click(screen.getByRole("link", { name: "Page suivante" }));

    await waitFor(() => expect(screen.getByTestId("results-refreshing")).toBeTruthy());
    expect(screen.queryByText("Actualisation des annonces…")).toBeNull();
    // Le compteur annonce toujours la même chose, sans texte de plus.
    const summary = screen.getByRole("heading", { level: 1 }).parentElement!;
    expect(within(summary).getByTestId("results-refreshing").textContent).toBe("");

    await act(async () => finish(sales));
    await waitFor(() => expect(screen.queryByTestId("results-refreshing")).toBeNull());
  });
});

describe("/sales : adresse nettoyée", () => {
  it("retire d'une adresse ouverte une valeur que la recherche ignore", async () => {
    renderSales("/sales?city=Pau&minPrice=-5&view=table");
    await waitFor(() => expect(window.location.search).toBe("?city=Pau&view=table"));
    expect(new URLSearchParams(window.location.search).has("minPrice")).toBe(false);
  });

  it("ramène un montant démesuré au plafond, sans notation scientifique", async () => {
    renderSales("/sales?maxPrice=1e%2B30");
    await waitFor(() => expect(window.location.search).toBe("?maxPrice=100000000"));
  });

  it("ne touche pas à une adresse déjà claire", () => {
    renderSales("/sales?city=Pau&sort=price_asc");
    // Seul l'appel qui pose l'adresse du test : la page ne la réécrit pas.
    expect(replaceStateCalls()).toEqual(["/sales?city=Pau&sort=price_asc"]);
  });
});

describe("/sales : page hors bornes", () => {
  it("dit que la page n'existe pas et renvoie à la page 1, sans parler de panne ni rejouer", async () => {
    state.fetchSearchResults.mockRejectedValue(new SearchRejectedError("Page hors limites."));
    state.fetchSearchCount.mockRejectedValue(new SearchRejectedError("Page hors limites."));
    renderSales("/sales?page=999&city=Pau", {
      client: new QueryClient({ defaultOptions: { queries: { retry: retrySearch } } }),
    });

    const link = await screen.findByRole("link", { name: "Revenir à la page 1" });
    expect(link.getAttribute("href")).toBe("/sales?city=Pau");
    expect(screen.getByText("Cette page n’existe pas pour cette recherche")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/ne répond pas/)).toBeNull();
    expect(screen.queryByText(/momentanément indisponible/)).toBeNull();
    // Refusée une fois, jamais rejouée.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(state.fetchSearchResults).toHaveBeenCalledTimes(1);
  });
});
