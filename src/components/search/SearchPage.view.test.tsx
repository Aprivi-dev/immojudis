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
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: null, loading: false, session: null, authError: null }),
}));
// next/dynamic reste réel ; seule la carte Mapbox est neutralisée.
vi.mock("./MapPanel", () => ({ MapPanel: () => <div data-testid="map-panel" /> }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/sales",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  // Comme Next : `history.replaceState` met `useSearchParams` à jour sans rechargement.
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

import { SalesPage } from "@/app/sales/sales-page";
import {
  ANONYMOUS_PREVIEW_SCOPE,
  salesSearchCountQueryKey,
  salesSearchQueryKey,
} from "@/lib/search/catalog-placeholder";

const sales = Array.from({ length: 24 }, (_, index) => ({
  id: `sale-${index + 1}`,
  starting_price_eur: 50_000 + index * 1000,
  sale_venue_type: index === 0 ? "tribunal" : "notary",
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

function renderSales(url: string, desktop = true) {
  window.history.replaceState(null, "", url);
  setViewport(desktop);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(salesSearchQueryKey("[]", ANONYMOUS_PREVIEW_SCOPE), sales);
  client.setQueryData(salesSearchCountQueryKey("[]", ANONYMOUS_PREVIEW_SCOPE), 100);
  return render(
    <QueryClientProvider client={client}>
      <SalesPage serverSeeded />
    </QueryClientProvider>,
  );
}

const currentParams = () => new URLSearchParams(window.location.search);

beforeEach(() => {
  state.fetchSearchResults.mockReset().mockResolvedValue(sales);
  state.fetchSearchCount.mockReset().mockResolvedValue(100);
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

describe("/sales : choix Cartes / Tableau", () => {
  it("affiche les cartes par défaut, avec le sélecteur sur Cartes", () => {
    renderSales("/sales");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getAllByRole("article")).toHaveLength(sales.length);
    expect(screen.getByRole("button", { name: "Cartes" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Tableau" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("bascule en tableau, mémorise le choix dans l'adresse et le rétablit aux cartes", async () => {
    renderSales("/sales?city=Lyon");
    fireEvent.click(screen.getByRole("button", { name: "Tableau" }));

    expect(await screen.findByRole("table")).toBeTruthy();
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(currentParams().get("view")).toBe("table");
    expect(currentParams().get("city")).toBe("Lyon");
    expect(screen.getByRole("button", { name: "Tableau" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    // Les mêmes annonces, une ligne chacune.
    await waitFor(() =>
      expect(
        within(screen.getAllByRole("rowgroup")[1]).getAllByRole("link", { name: /^Voir / }),
      ).toHaveLength(sales.length),
    );

    fireEvent.click(screen.getByRole("button", { name: "Cartes" }));
    await waitFor(() => expect(screen.queryByRole("table")).toBeNull());
    expect(screen.getAllByRole("article")).toHaveLength(sales.length);
    expect(currentParams().has("view")).toBe(false);
    expect(currentParams().get("city")).toBe("Lyon");
  });

  it("rouvre directement le tableau depuis une adresse partagée", async () => {
    renderSales("/sales?view=table&sort=price_asc");
    expect(await screen.findByRole("table")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tableau" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("ne relance aucune recherche en changeant d'affichage", async () => {
    renderSales("/sales");
    fireEvent.click(screen.getByRole("button", { name: "Tableau" }));
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "Cartes" }));
    await waitFor(() => expect(screen.queryByRole("table")).toBeNull());
    expect(state.fetchSearchResults).not.toHaveBeenCalled();
    expect(state.fetchSearchCount).not.toHaveBeenCalled();
  });

  it("réutilise le tri existant et garde le tableau quand le tri change", async () => {
    renderSales("/sales?view=table");
    await screen.findByRole("table");
    fireEvent.change(screen.getByRole("combobox", { name: "Tri" }), {
      target: { value: "price_asc" },
    });
    await waitFor(() => expect(currentParams().get("sort")).toBe("price_asc"));
    expect(currentParams().get("view")).toBe("table");
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("garde le tableau dans les liens de pagination et dans le retour des fiches", () => {
    renderSales("/sales?view=table");
    const next = screen
      .getAllByRole("link")
      .find((link) => (link.getAttribute("href") ?? "").includes("page=2"));
    expect(new URLSearchParams(next?.getAttribute("href")?.split("?")[1]).get("view")).toBe(
      "table",
    );
    const fiche = screen.getAllByRole("link", { name: /^Voir / })[0];
    // Pas de ?from= dans le HTML du serveur : l'origine s'ajoute dès que le lien est approché.
    expect(fiche.getAttribute("href")).not.toContain("from=");
    fireEvent.pointerEnter(fiche);
    expect(decodeURIComponent(fiche.getAttribute("href") ?? "")).toContain("view=table");
  });

  it("reste en cartes sur mobile, même avec view=table dans l'adresse", () => {
    renderSales("/sales?view=table", false);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getAllByRole("article")).toHaveLength(sales.length);
    // Le sélecteur existe dans le DOM mais le CSS le masque sous lg.
    expect(
      screen.getByRole("group", { name: "Affichage des résultats", hidden: true }).className,
    ).toContain("lg:block");
  });
});

describe("/sales : la carte du bureau ne démarre qu'au premier geste", () => {
  it("réserve le cadre de la carte avec un aperçu et un bouton nommé, sans charger la carte", async () => {
    renderSales("/sales");
    // Premier affichage : la liste est là, la carte n'est pas initialisée. Le module de la carte
    // (simulé) se chargerait en quelques millisecondes si rien ne le différait.
    expect(screen.getAllByRole("article")).toHaveLength(sales.length);
    const preview = screen.getByTestId("map-preview");
    expect(within(preview).getByRole("button", { name: "Afficher la carte" })).toBeTruthy();
    expect(screen.queryByText("Chargement de la carte")).toBeNull();

    // Ni inactivité du navigateur ni minuteur ne la lancent (l'ancien repli était de 300 ms,
    // le plafond de 5 s).
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByTestId("map-panel")).toBeNull();
    expect(screen.getByTestId("map-preview")).toBeTruthy();
  });

  it.each(["pointerDown", "wheel", "touchStart"] as const)(
    "démarre la carte au premier geste (%s)",
    async (gesture) => {
      renderSales("/sales");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(screen.queryByTestId("map-panel")).toBeNull();

      fireEvent[gesture](window);
      expect(await screen.findByTestId("map-panel", undefined, { timeout: 500 })).toBeTruthy();
      expect(screen.queryByTestId("map-preview")).toBeNull();
    },
  );

  it("ne démarre pas la carte à Tab ni à une touche : le focus reste sur le bouton", async () => {
    renderSales("/sales");
    const button = screen.getByRole("button", { name: "Afficher la carte" });
    act(() => button.focus());
    fireEvent.keyDown(button, { key: "Tab" });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.focus(screen.getByTestId("map-preview"));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByTestId("map-panel")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("démarre la carte au clic sur « Afficher la carte », avec le focus sur la carte", async () => {
    renderSales("/sales");
    fireEvent.click(screen.getByRole("button", { name: "Afficher la carte" }));
    expect(await screen.findByTestId("map-panel")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Afficher la carte" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Carte des ventes" }));
    expect(screen.getByText("Carte affichée")).toBeTruthy();
  });

  it("démarre la carte après 300 ms de survol continu, pas avant", async () => {
    renderSales("/sales");
    fireEvent.pointerEnter(screen.getByTestId("map-preview"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.queryByTestId("map-panel")).toBeNull();
    expect(await screen.findByTestId("map-panel", undefined, { timeout: 1000 })).toBeTruthy();
  });

  it("ne démarre pas la carte quand la souris ne fait que traverser sa zone", async () => {
    renderSales("/sales");
    const preview = screen.getByTestId("map-preview");
    fireEvent.pointerEnter(preview);
    await new Promise((resolve) => setTimeout(resolve, 100));
    fireEvent.pointerLeave(preview);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(screen.queryByTestId("map-panel")).toBeNull();
  });

  it("n'ajoute ni carte, ni aperçu, ni cadre de carte sur mobile", async () => {
    renderSales("/sales", false);
    await new Promise((resolve) => setTimeout(resolve, 400));
    fireEvent.pointerDown(window);
    expect(screen.queryByTestId("map-panel")).toBeNull();
    expect(screen.queryByTestId("map-preview")).toBeNull();
    expect(screen.queryByRole("button", { name: "Afficher la carte" })).toBeNull();
    expect(screen.queryByText("Chargement de la carte")).toBeNull();
  });
});
