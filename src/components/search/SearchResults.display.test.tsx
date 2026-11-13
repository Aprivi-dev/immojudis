// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";
import { ListingCard } from "./SearchResults";
import { SearchResultsTable } from "./SearchResultsTable";

/**
 * Textes des cartes et du tableau de /sales : « 114 m² » ne se coupe pas, le nom de la commune
 * s'écrit d'une seule façon, et une carte sans photo ne répète pas aux lecteurs d'écran
 * « Illustration » et la longue description du dessin.
 */
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: null, loading: false }) }));
vi.mock("@/hooks/use-viewed-sales", () => ({ useViewedSales: () => ({ isViewed: () => false }) }));
vi.mock("@/lib/client-api", () => ({
  addFavoriteSale: vi.fn(),
  removeFavoriteSale: vi.fn(),
  fetchSaleUnlocksOverview: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

afterEach(cleanup);

// Sans photo ni position : la carte montre l'illustration du type de bien.
const aixSale = {
  id: "sale-aix",
  city: "Aix-En-Provence",
  department: "13",
  property_type: "apartment",
  sale_venue_type: "tribunal",
  starting_price_eur: 100_000,
  app_surface_m2: 114,
  rooms_count: 4,
  sale_date: "2099-11-20T09:00:00Z",
  media: [],
} as unknown as AuctionSale;

function renderCard(onToggleComparison = vi.fn(), sale: AuctionSale = aixSale) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ListingCard
        sale={sale}
        returnTo="/sales"
        locked={false}
        analysisLocked={false}
        active={false}
        onHover={vi.fn()}
        onSelect={vi.fn()}
        onToggleComparison={onToggleComparison}
      />
    </QueryClientProvider>,
  );
}

describe("carte de /sales : titre", () => {
  it("garde « 114 m² » sur une ligne et écrit « Aix-en-Provence »", () => {
    renderCard();
    const heading = screen.getByRole("heading", {
      level: 3,
      name: "Appartement de 114 m² à Aix-en-Provence",
    });
    // Le nombre et son unité dans un même bloc insécable ; le texte lui-même ne change pas.
    const units = [...heading.querySelectorAll("span.whitespace-nowrap")].map(
      (unit) => unit.textContent,
    );
    expect(units).toEqual(["114 m²"]);
    const facts = screen.getByTestId("card-facts-line");
    expect(facts.querySelector("span.whitespace-nowrap")?.textContent).toBe("114 m²");
    expect(document.body.textContent).not.toContain("Aix-En-Provence");
  });

  it("transmet la vente telle quelle à la comparaison (mise en forme à l'affichage seulement)", () => {
    const onToggleComparison = vi.fn();
    renderCard(onToggleComparison);
    fireEvent.click(screen.getByRole("button", { name: /^Comparer / }));
    expect(onToggleComparison).toHaveBeenCalledWith(aixSale);
  });
});

describe("carte de /sales sans photo", () => {
  it("garde l'illustration et sa pastille à l'écran, mais hors de l'arbre d'accessibilité", () => {
    renderCard();
    const fallback = screen.getByTestId("sale-media-fallback-sale-aix");
    expect(fallback.getAttribute("aria-hidden")).toBe("true");
    // Visible : le dessin et la pastille « Illustration » (docs/design/fondations.md).
    expect(fallback.querySelector("[data-illustration]")).not.toBeNull();
    expect(fallback.textContent).toContain("Illustration");
    // Lu : rien de tout cela, le lien de la carte suffit.
    expect(screen.queryByRole("img", { name: /Illustration générique/ })).toBeNull();
    expect(screen.getByRole("img", { name: /Illustration générique/, hidden: true })).toBeTruthy();
  });
});

describe("tableau de /sales", () => {
  it("écrit la commune mise en forme", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SearchResultsTable
          sales={[aixSale]}
          returnTo="/sales"
          locked={false}
          analysisLocked={false}
          verifying={false}
          isLoading={false}
          selectedSaleId={null}
          hoveredSaleId={null}
          onHover={vi.fn()}
          onSelect={vi.fn()}
          unlockedIds={new Set()}
          favoriteIds={new Set()}
          favoriteScope={null}
          FavoriteButton={() => null}
        />
      </QueryClientProvider>,
    );
    const row = screen.getAllByRole("rowheader")[0];
    expect(row.textContent).toContain("Aix-en-Provence");
    expect(document.body.textContent).not.toContain("Aix-En-Provence");
  });
});

describe("carte de /sales : repère « Annonce bien renseignée »", () => {
  it("s'affiche sur une annonce du palier haut, avec sa réserve et le lien vers le classement", async () => {
    renderCard(vi.fn(), { ...aixSale, completeness_tier: 1 });
    // Pastille chargée à part (`next/dynamic`) : elle arrive après le premier rendu du test.
    expect(await screen.findByText("Annonce bien renseignée")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "À propos du repère « Annonce bien renseignée »" }),
    );
    expect(screen.getByRole("note").textContent).toContain("ni une vérification ni une garantie");
    expect(screen.getByRole("link", { name: "Comment ça marche ?" }).getAttribute("href")).toBe(
      "/classement-des-annonces",
    );
  });

  it.each([0, null, undefined])("ne s'affiche pas pour un palier %s", (tier) => {
    renderCard(vi.fn(), { ...aixSale, completeness_tier: tier });
    expect(screen.queryByText("Annonce bien renseignée")).toBeNull();
  });
});
