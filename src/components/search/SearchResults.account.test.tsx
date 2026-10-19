// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";
import { ListingCard, ListingMediaCarousel, SearchResultsList } from "./SearchResults";

const testState = vi.hoisted(() => ({
  user: null as { id: string } | null,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: testState.user, loading: false }),
}));
vi.mock("@/hooks/use-viewed-sales", () => ({ useViewedSales: () => ({ isViewed: () => false }) }));
vi.mock("@/integrations/supabase/lazy", () => ({
  getSupabase: async () => {
    throw new Error("Aucun appel Supabase attendu dans ce test");
  },
}));
vi.mock("@/lib/client-api", () => ({
  addFavoriteSale: vi.fn(),
  removeFavoriteSale: vi.fn(),
  fetchSaleUnlocksOverview: vi.fn(async () => ({ status: {}, sales: [] })),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  testState.user = null;
});

const FREE_LINE = "Gratuit, sans carte bancaire · 3 fiches détaillées par mois";

function sale(id: string, extra: Record<string, unknown> = {}): AuctionSale {
  return {
    id,
    city: id,
    property_type: "apartment",
    sale_venue_type: "tribunal",
    media: [],
    ...extra,
  } as unknown as AuctionSale;
}

function withClient(children: ReactNode) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}

function renderList(sales: AuctionSale[], locked: boolean, placement?: ReactNode) {
  return render(
    withClient(
      <SearchResultsList
        sales={sales}
        sponsoredPlacement={placement}
        returnTo="/sales"
        locked={locked}
        analysisLocked
        isLoading={false}
        error={null}
        selectedSaleId={null}
        hoveredSaleId={null}
        onHover={vi.fn()}
        onSelect={vi.fn()}
        comparedSaleIds={[]}
        comparisonDisabled={false}
        onToggleComparison={vi.fn()}
      />,
    ),
  );
}

describe("compte en cours de vérification", () => {
  it("ne promet pas un compte gratuit à une personne déjà connectée", () => {
    testState.user = { id: "user-a" };
    renderList([sale("sale-a"), sale("sale-b")], true);
    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.textContent).not.toContain(FREE_LINE);
      expect(card.textContent).not.toContain("Fiche complète avec un compte gratuit");
      expect(card.textContent).toContain("Voir le détail");
    }
  });

  it("garde l'argument « compte gratuit » pour le visiteur sans compte", () => {
    renderList([sale("sale-a"), sale("sale-b")], true);
    for (const card of screen.getAllByRole("article")) {
      expect(card.textContent).toContain(FREE_LINE);
    }
  });
});

describe("date d'une vente passée", () => {
  const renderCard = (saleToShow: AuctionSale) =>
    render(
      withClient(
        <ListingCard
          sale={saleToShow}
          returnTo="/sales"
          locked={false}
          analysisLocked={false}
          active={false}
          onHover={vi.fn()}
          onSelect={vi.fn()}
        />,
      ),
    );

  it("dit « Vente passée » au lieu d'une date de 2020", () => {
    renderCard(sale("sale-dated", { sale_date: "2020-03-12T09:00:00Z" }));
    // La date est remplacée (le compte à rebours peut aussi dire « Vente passée » : au moins un).
    expect(screen.getAllByText("Vente passée").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("2020");
  });

  it("garde la date d'une vente à venir", () => {
    renderCard(sale("sale-dated", { sale_date: "2099-03-12T09:00:00Z" }));
    expect(screen.queryByText("Vente passée")).toBeNull();
    expect(document.body.textContent).toContain("mars 2099");
  });
});

describe("lien vers la fiche : l'origine s'ajoute au toucher, pas dans le HTML", () => {
  const renderCard = (returnTo: string) =>
    render(
      withClient(
        <ListingCard
          sale={sale("sale-a")}
          returnTo={returnTo}
          locked={false}
          analysisLocked={false}
          active={false}
          onHover={vi.fn()}
          onSelect={vi.fn()}
        />,
      ),
    );

  it("n'écrit aucun ?from= dans les liens du premier rendu, même sur une page paginée", () => {
    renderCard("/sales?page=2");
    const links = screen.getAllByRole("link", { hidden: true });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link.getAttribute("href")).toBe("/sales/sale-a");
  });

  it.each([
    ["le survol", (link: HTMLElement) => fireEvent.pointerEnter(link)],
    ["le focus clavier", (link: HTMLElement) => fireEvent.focus(link)],
    ["l'appui", (link: HTMLElement) => fireEvent.pointerDown(link)],
    ["le toucher", (link: HTMLElement) => fireEvent.touchStart(link)],
  ])("ajoute le retour vers la recherche dès %s, avant le clic", (_name, approach) => {
    renderCard("/sales?page=2&sort=price_asc");
    const link = screen.getByRole("link", { name: /^Voir / });
    approach(link);
    expect(link.getAttribute("href")).toBe(
      "/sales/sale-a?from=%2Fsales%3Fpage%3D2%26sort%3Dprice_asc",
    );
  });

  it("ne change rien pour la recherche sans critère : /sales reste l'adresse par défaut", () => {
    renderCard("/sales");
    const link = screen.getByRole("link", { name: /^Voir / });
    fireEvent.pointerEnter(link);
    expect(link.getAttribute("href")).toBe("/sales/sale-a");
  });

  it("donne aussi l'origine au lien de la photo, qui mène à la même fiche", () => {
    render(
      withClient(
        <ListingMediaCarousel
          sale={sale("sale-a", {
            media: [{ type: "image", url: "https://cdn.example.com/a.jpg" }],
          })}
          locked={false}
          title="Appartement"
          returnTo="/sales?page=3"
        />,
      ),
    );
    const photoLink = screen.getByRole("link", { hidden: true });
    expect(photoLink.getAttribute("href")).toBe("/sales/sale-a");
    fireEvent.pointerEnter(photoLink);
    expect(photoLink.getAttribute("href")).toBe("/sales/sale-a?from=%2Fsales%3Fpage%3D3");
  });
});

describe("clavier : un seul lien et un seul arrêt par carte pour la fiche", () => {
  it("sort le lien de la photo de l'ordre de tabulation et le masque aux lecteurs d'écran", () => {
    render(
      withClient(
        <ListingMediaCarousel
          sale={sale("sale-gallery", {
            media: [
              { type: "image", url: "https://cdn.example.com/a.jpg" },
              { type: "image", url: "https://cdn.example.com/b.jpg" },
            ],
          })}
          locked={false}
          title="Appartement à Bordeaux"
        />,
      ),
    );
    const region = screen.getByRole("region", { name: "Photos de Appartement à Bordeaux" });
    expect(region.hasAttribute("tabindex")).toBe(false);
    const photoLink = screen.getByRole("link", { hidden: true });
    expect(photoLink.getAttribute("tabindex")).toBe("-1");
    expect(photoLink.getAttribute("aria-hidden")).toBe("true");
    // Les flèches restent des boutons, atteints au clavier.
    expect(screen.getByRole("button", { name: "Photo précédente" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Photo suivante" })).toBeTruthy();
  });
});

describe("encart sponsorisé", () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];

  it("passe après la dernière annonce, jamais entre deux annonces", () => {
    renderList(
      ids.map((id) => sale(id)),
      true,
      <div data-testid="sponsored-placement">Partenaire</div>,
    );
    const cards = screen.getAllByRole("article");
    const placement = screen.getByTestId("sponsored-placement");
    expect(cards).toHaveLength(8);
    expect(
      cards[7]!.compareDocumentPosition(placement) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    for (const card of cards) expect(card.contains(placement)).toBe(false);
  });

  it("n'apparaît pas quand l'appelant n'en fournit pas (pages 2 et suivantes)", () => {
    renderList(
      ids.map((id) => sale(id)),
      true,
    );
    expect(screen.queryByTestId("sponsored-placement")).toBeNull();
    expect(screen.getAllByRole("article")).toHaveLength(8);
  });
});
