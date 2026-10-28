// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";
import type { AiReviewProjectionReadModel } from "@/lib/ai-review-guard";
import {
  EAGER_IMAGE_COUNT,
  ListingCard,
  ListingMediaCarousel,
  SearchResultsList,
} from "./SearchResults";
import { SearchStatisticsPanel } from "./SearchStatisticsPanel";
import { buildSearchStatistics } from "./search-page-state";

const testState = vi.hoisted(() => {
  const favoriteQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
  };
  favoriteQuery.select.mockReturnValue(favoriteQuery);
  favoriteQuery.eq.mockReturnValue(favoriteQuery);

  return {
    auth: {
      current: {
        user: null as { id: string } | null,
        loading: false,
      },
    },
    favoriteQuery,
    supabase: {
      from: vi.fn(() => favoriteQuery),
    },
    addFavoriteSale: vi.fn(),
    removeFavoriteSale: vi.fn(),
    unlocksOverview: vi.fn(),
    push: vi.fn(),
  };
});

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => testState.auth.current }));
const viewedState = vi.hoisted(() => ({ viewed: false }));
vi.mock("@/hooks/use-viewed-sales", () => ({
  useViewedSales: () => ({ isViewed: () => viewedState.viewed }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: testState.supabase }));
vi.mock("@/lib/client-api", () => ({
  addFavoriteSale: testState.addFavoriteSale,
  removeFavoriteSale: testState.removeFavoriteSale,
  fetchSaleUnlocksOverview: testState.unlocksOverview,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: testState.push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/components/SaleVisual", () => ({
  SaleVisual: ({
    locked,
    title,
    thumbnail,
    mapWidth,
    mapHeight,
    mapFramingWidth,
    eager,
  }: {
    locked: boolean;
    title: string;
    thumbnail?: boolean;
    mapWidth?: number;
    mapHeight?: number;
    mapFramingWidth?: number;
    eager?: boolean;
  }) => (
    <div
      data-testid="sale-visual"
      data-eager={String(Boolean(eager))}
      data-thumbnail={String(Boolean(thumbnail))}
      data-map-size={`${mapWidth}x${mapHeight}`}
      data-map-framing={mapFramingWidth}
    >
      {locked ? "Visuel réservé" : `Visuel : ${title}`}
    </div>
  ),
}));
afterEach(() => {
  cleanup();
  viewedState.viewed = false;
  testState.auth.current = { user: null, loading: false };
  testState.supabase.from.mockClear();
  testState.favoriteQuery.select.mockClear().mockReturnValue(testState.favoriteQuery);
  testState.favoriteQuery.eq.mockClear().mockReturnValue(testState.favoriteQuery);
  testState.favoriteQuery.in.mockReset();
  testState.addFavoriteSale.mockReset().mockResolvedValue({});
  testState.removeFavoriteSale.mockReset().mockResolvedValue({});
  testState.unlocksOverview.mockReset().mockResolvedValue({ status: {}, sales: [] });
  testState.push.mockReset();
});

function setAuthenticatedUser(id: string | null) {
  testState.auth.current = {
    user: id ? { id } : null,
    loading: false,
  };
}

function tribunalSale(id: string): AuctionSale {
  return { ...sale(id), sale_venue_type: "tribunal" } as unknown as AuctionSale;
}

function sale(id: string): AuctionSale {
  return {
    id,
    city: id,
    property_type: "apartment",
    media: [],
  } as unknown as AuctionSale;
}

function renderResults(
  sales: AuctionSale[],
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <SearchResultsList
          sales={sales}
          returnTo="/sales"
          locked={false}
          analysisLocked={false}
          isLoading={false}
          error={null}
          selectedSaleId={null}
          hoveredSaleId={null}
          onHover={vi.fn()}
          onSelect={vi.fn()}
          comparedSaleIds={[]}
          comparisonDisabled={false}
          onToggleComparison={vi.fn()}
        />
      </QueryClientProvider>,
    ),
  };
}

describe("useful public discovery", () => {
  it("selects directly from the card without navigating and only disables unselected cards at the limit", () => {
    const sales = ["a", "b", "c", "d"].map(
      (id) =>
        ({
          id,
          city: id,
          property_type: "apartment",
          media: [],
        }) as unknown as AuctionSale,
    );
    const onSelect = vi.fn();
    const onToggleComparison = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SearchResultsList
          sales={sales}
          returnTo="/sales"
          locked
          analysisLocked
          isLoading={false}
          error={null}
          selectedSaleId={null}
          hoveredSaleId={null}
          onHover={vi.fn()}
          onSelect={onSelect}
          comparedSaleIds={["a", "b", "c"]}
          comparisonDisabled={false}
          onToggleComparison={onToggleComparison}
        />
      </QueryClientProvider>,
    );
    const selected = screen.getByRole("button", { name: "Comparer Appartement à a" });
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(selected);
    expect(onToggleComparison).toHaveBeenCalledWith(sales[0]);
    expect(onSelect).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("button", { name: "Comparer Appartement à d" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("gives high image priority to the first card only", () => {
    renderResults([sale("eager-a"), sale("eager-b"), sale("eager-c")]);
    const eager = screen.getAllByTestId("sale-visual").map((visual) => visual.dataset.eager);
    expect(eager).toEqual(["true", "false", "false"]);
    expect(EAGER_IMAGE_COUNT).toBe(1);
  });

  it("keeps the active card synchronized with hover after memoization", () => {
    function HoverableResults() {
      const [hoveredSaleId, setHoveredSaleId] = useState<string | null>(null);
      return (
        <QueryClientProvider client={new QueryClient()}>
          <SearchResultsList
            sales={[sale("hover-a"), sale("hover-b")]}
            returnTo="/sales"
            locked
            analysisLocked
            isLoading={false}
            error={null}
            selectedSaleId={null}
            hoveredSaleId={hoveredSaleId}
            onHover={setHoveredSaleId}
            onSelect={vi.fn()}
            comparedSaleIds={[]}
            comparisonDisabled={false}
            onToggleComparison={vi.fn()}
          />
        </QueryClientProvider>
      );
    }

    render(<HoverableResults />);
    const cards = screen.getAllByRole("article");
    fireEvent.mouseEnter(cards[0]!);
    expect(cards[0]!.className).toContain("ring-1");
    expect(cards[1]!.className).not.toContain("ring-1");

    fireEvent.mouseEnter(cards[1]!);
    expect(cards[0]!.className).not.toContain("ring-1");
    expect(cards[1]!.className).toContain("ring-1");
  });

  it("shows listing facts and honest upgrade labels without fake scores", () => {
    const sale = {
      id: "sale-public",
      city: "Bordeaux",
      department: "33",
      property_type: "apartment",
      starting_price_eur: 90000,
      sale_date: "2099-10-01T09:00:00Z",
      app_surface_m2: 60,
      app_surface_kind: "habitable",
      rooms_count: 3,
      bedrooms_count: 2,
      sale_venue_type: "tribunal",
      media: [],
    } as unknown as AuctionSale;
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ListingCard
          sale={sale}
          returnTo="/sales"
          locked
          analysisLocked={false}
          active={false}
          onHover={vi.fn()}
          onSelect={vi.fn()}
        />
      </QueryClientProvider>,
    );
    // Titre court de la fiche ; la surface y figure, la ligne dessous dit le département et les pièces.
    expect(screen.getByRole("heading", { name: "Appartement de 60 m² à Bordeaux" })).toBeTruthy();
    expect(screen.getByText(/Gironde \(33\) · 3 pièces/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Définition : mise à prix" })).toBeTruthy();
    expect(screen.getByText("mise à prix").className).not.toContain("text-xs");
    expect(screen.getAllByText(/oct/i).length).toBeGreaterThan(0);
    for (const text of [
      "Visuel réservé",
      "Localisation réservée",
      "Date réservée",
      "78/100",
      "8 pièces",
      "3 alertes",
    ]) {
      expect(container.textContent).not.toContain(text);
    }
    expect(container.querySelector('[class*="blur-"]')).toBeNull();
    expect(
      screen.getByText("Gratuit, sans carte bancaire · 3 déblocages par mois"),
    ).toBeTruthy();
  });

  it("titles the card with the sale page's short heading, with a clean fallback", () => {
    const renderCard = (fields: Record<string, unknown>) =>
      render(
        <QueryClientProvider client={new QueryClient()}>
          <ListingCard
            sale={
              {
                id: "sale-fallback",
                starting_price_eur: 90000,
                media: [],
                sale_venue_type: "notary",
                ...fields,
              } as unknown as AuctionSale
            }
            returnTo="/sales"
            locked
            analysisLocked={false}
            active={false}
            onHover={vi.fn()}
            onSelect={vi.fn()}
          />
        </QueryClientProvider>,
      );

    renderCard({ property_type: "house", city: "Lille", department: "59" });
    expect(screen.getByRole("heading", { name: "Maison à Lille" })).toBeTruthy();
    cleanup();

    // Unknown type: « Bien immobilier », never an internal code.
    renderCard({ property_type: "other", city: "Lille", department: "59" });
    expect(screen.getByRole("heading", { name: "Bien immobilier à Lille" })).toBeTruthy();
    cleanup();

    // No city: the type alone, the department takes over below the title.
    renderCard({ property_type: "apartment", city: null, department: "Gironde" });
    expect(screen.getByRole("heading", { name: "Appartement" })).toBeTruthy();
    expect(screen.getByText(/^Gironde/).textContent).toMatch(/^Gironde.* · /);
    cleanup();

    // Neither city nor department: say so rather than leave a hole.
    renderCard({ property_type: "apartment", city: "  ", department: null });
    expect(screen.getByRole("heading", { name: "Appartement" })).toBeTruthy();
    expect(screen.getByText("Localisation à préciser").parentElement?.textContent).toMatch(
      /^Localisation à préciser · /,
    );
  });

  it("keeps the old reassurance on a locked sale that cannot be unlocked (no fee regime: domanial)", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ListingCard
          sale={
            {
              id: "sale-state",
              city: "Lyon",
              property_type: "apartment",
              sale_venue_type: "state",
              media: [],
            } as unknown as AuctionSale
          }
          returnTo="/sales"
          locked
          analysisLocked={false}
          active={false}
          onHover={vi.fn()}
          onSelect={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Fiche complète avec un compte gratuit")).toBeTruthy();
    expect(screen.queryByText(/déblocages par mois/)).toBeNull();
  });

  it("laisse « Annonce bien renseignée » à la fiche : la carte ne la montre plus", () => {
    // Décision du 24/10/2026 (docs/design/fondations.md) : deux pastilles au plus par carte,
    // l'échéance et les points à vérifier ; la qualité de l'annonce n'est dite que sur la fiche.
    for (const locked of [true, false]) {
      render(
        <QueryClientProvider client={new QueryClient()}>
          <ListingCard
            sale={{ ...sale("tier-card"), completeness_tier: 1 } as AuctionSale}
            returnTo="/sales"
            locked={locked}
            analysisLocked={false}
            active={false}
            onHover={vi.fn()}
            onSelect={vi.fn()}
          />
        </QueryClientProvider>,
      );
      expect(screen.queryByText("Annonce bien renseignée")).toBeNull();
      cleanup();
    }
  });

  describe("pastille « N points à vérifier »", () => {
    const cardSale = (overrides: Record<string, unknown> = {}) =>
      ({
        ...sale("verify-card"),
        sale_date: "2099-01-20T09:00:00Z",
        app_surface_m2: 50,
        app_surface_kind: "habitable",
        occupancy_status: "libre",
        status: "upcoming",
        ...overrides,
      }) as unknown as AuctionSale;
    const renderCard = (
      cardOverrides: Record<string, unknown>,
      access: { locked: boolean; analysisLocked: boolean } = {
        locked: false,
        analysisLocked: false,
      },
    ) =>
      render(
        <QueryClientProvider client={new QueryClient()}>
          <ListingCard
            sale={cardSale(cardOverrides)}
            returnTo="/sales"
            {...access}
            active={false}
            onHover={vi.fn()}
            onSelect={vi.fn()}
          />
        </QueryClientProvider>,
      );

    it("compte les points déjà visibles sur la carte et mène à la fiche", () => {
      renderCard({ app_surface_m2: null, occupancy_status: null });
      expect(screen.getByText(/surface non communiquée/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "2 points à vérifier" }));
      const note = screen.getByRole("note");
      expect(note.textContent).toContain("Surface non communiquée dans l’annonce");
      expect(note.textContent).toContain("Occupation du bien à vérifier");
      expect(screen.getByRole("link", { name: "Voir la fiche" }).getAttribute("href")).toBe(
        "/sales/verify-card#points-a-verifier",
      );
    });

    it("montre le prix au m² de la mise à prix quand la surface est publiée, et seulement alors", () => {
      renderCard({ starting_price_eur: 60_000, app_surface_m2: 50 });
      expect(screen.getByText(/1\s?200\s€\/m²/)).toBeTruthy();
      cleanup();
      renderCard({ starting_price_eur: 60_000, app_surface_m2: null });
      expect(screen.queryByText(/€\/m²/)).toBeNull();
      cleanup();
      renderCard({ starting_price_eur: 0, app_surface_m2: 50 });
      expect(screen.queryByText(/€\/m²/)).toBeNull();
    });

    it("donne à « Comparer » une bordure visible, qui change à la sélection", () => {
      const onToggle = vi.fn();
      render(
        <QueryClientProvider client={new QueryClient()}>
          <ListingCard
            sale={cardSale()}
            returnTo="/sales"
            locked={false}
            analysisLocked={false}
            active={false}
            onHover={vi.fn()}
            onSelect={vi.fn()}
            onToggleComparison={onToggle}
            comparisonSelected={false}
          />
        </QueryClientProvider>,
      );
      const button = screen.getByRole("button", { name: /^Comparer / });
      expect(button.className).toContain("border");
      expect(button.className).toContain("border-brand-navy/55");
    });

    it("n'affiche rien pour une carte complète", () => {
      renderCard({});
      expect(screen.queryByRole("button", { name: /à vérifier/ })).toBeNull();
    });

    it("ne compte pas l'occupation quand la carte ne la montre pas (liste publique, compte gratuit)", () => {
      renderCard({ occupancy_status: null }, { locked: true, analysisLocked: false });
      expect(screen.queryByRole("button", { name: /à vérifier/ })).toBeNull();
      cleanup();
      renderCard({ occupancy_status: null }, { locked: false, analysisLocked: true });
      expect(screen.queryByRole("button", { name: /à vérifier/ })).toBeNull();
      cleanup();
      renderCard(
        { occupancy_status: null, app_surface_m2: null },
        { locked: true, analysisLocked: false },
      );
      expect(screen.getByRole("button", { name: "1 point à vérifier" })).toBeTruthy();
    });

    it("montre l'occupation dans la ligne du bien, pas dans une pastille", () => {
      renderCard({ occupancy_status: "libre" });
      expect(screen.getByRole("heading", { level: 3 }).nextElementSibling?.textContent).toBe(
        "libre",
      );
      expect(screen.queryByRole("button", { name: /à vérifier/ })).toBeNull();
    });
  });

  it("shows a starting price of 0 as not communicated on the listing card", () => {
    const sale = {
      id: "sale-zero",
      city: "Lille",
      department: "59",
      property_type: "apartment",
      starting_price_eur: 0,
      sale_date: "2026-10-01T09:00:00Z",
      sale_venue_type: "tribunal",
      media: [],
    } as unknown as AuctionSale;
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ListingCard
          sale={sale}
          returnTo="/sales"
          locked
          analysisLocked={false}
          active={false}
          onHover={vi.fn()}
          onSelect={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(container.textContent).toContain("Prix non communiqué");
    expect(container.textContent).not.toMatch(/0\s?€/);
  });

  describe("price of a domanial sale", () => {
    const renderStateCard = (fields: Record<string, unknown>) =>
      render(
        <QueryClientProvider client={new QueryClient()}>
          <ListingCard
            sale={
              {
                id: "sale-state",
                city: "Lille",
                department: "59",
                property_type: "land",
                sale_date: "2099-10-01T09:00:00Z",
                sale_venue_type: "state",
                media: [],
                ...fields,
              } as unknown as AuctionSale
            }
            returnTo="/sales"
            locked
            analysisLocked={false}
            active={false}
            onHover={vi.fn()}
            onSelect={vi.fn()}
          />
        </QueryClientProvider>,
      );

    it("says « Prix non publié » when the State publishes no price, without « mise à prix »", () => {
      for (const price of [null, 0]) {
        const { container, unmount } = renderStateCard({ starting_price_eur: price });
        expect(container.textContent).toContain("Prix non publié");
        expect(container.textContent).not.toContain("Prix non communiqué");
        expect(container.textContent).not.toContain("mise à prix");
        unmount();
      }
    });

    it("keeps the published price of a domanial sale", () => {
      const { container } = renderStateCard({ starting_price_eur: 125_000 });
      expect(container.textContent).toMatch(/125\s000\s€/);
      expect(container.textContent).not.toContain("Prix non publié");
    });
  });

  it("offers a working example instead of fabricated statistics", () => {
    const { container } = render(
      <SearchStatisticsPanel
        statistics={buildSearchStatistics([])}
        locked
        dpeLocked
        loading={false}
        dpeExplorerLoading={false}
        dpeExplorerError={null}
        dpeExplorerRequested={false}
        onLoadDpeExplorer={vi.fn()}
      />,
    );
    expect(
      screen
        .getByRole("link", { name: "Essayer une analyse complète sans compte" })
        .getAttribute("href"),
    ).toBe("/annonce-exemple");
    expect(container.textContent).not.toContain("148 000");
    expect(container.textContent).not.toContain("76/100");
    expect(container.querySelector('[class*="blur-"]')).toBeNull();
  });

  it("requests the DPE explorer only when the user activates it", () => {
    const onLoadDpeExplorer = vi.fn();
    render(
      <SearchStatisticsPanel
        statistics={buildSearchStatistics([])}
        locked={false}
        dpeLocked={false}
        loading={false}
        dpeExplorerLoading={false}
        dpeExplorerError={null}
        dpeExplorerRequested={false}
        onLoadDpeExplorer={onLoadDpeExplorer}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Explorer DPE" }));
    expect(onLoadDpeExplorer).toHaveBeenCalledOnce();
  });

  it("hides a property type explicitly blocked by the AI review projection", () => {
    const sale = {
      id: "sale-ai-blocked",
      city: "Bordeaux",
      department: "33",
      property_type: "apartment",
      starting_price_eur: 90000,
      sale_date: "2026-10-01T09:00:00Z",
      app_surface_m2: 60,
      app_surface_kind: "habitable",
      media: [],
      source_name: "AGRASC",
      source_url: "https://agrasc.gouv.fr/vente/1",
    } as unknown as AuctionSale;
    const projection: AiReviewProjectionReadModel = {
      auction_sale_id: sale.id,
      field_key: "property.property_type",
      review_state: "unresolved",
      citation_status: "not_required",
      is_publishable: false,
      source_name: "AGRASC",
      source_url: "https://agrasc.gouv.fr/vente/1",
    };

    render(
      <QueryClientProvider client={new QueryClient()}>
        <ListingCard
          sale={sale}
          aiReviewProjections={[projection]}
          returnTo="/sales"
          locked={false}
          analysisLocked={false}
          active={false}
          onHover={vi.fn()}
          onSelect={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Type de bien à confirmer")).toBeTruthy();
    expect(screen.queryByText("Appartement", { exact: true })).toBeNull();
    expect(screen.getByRole("heading", { level: 3 }).textContent).toContain(
      "Source : AGRASC à Bordeaux",
    );
    expect(screen.getByText(/Source : AGRASC/)).toBeTruthy();
  });

  it("uses the guarded card title in the native share payload", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: share,
    });
    const sale = {
      id: "sale-city-blocked",
      title: "Appartement à Bordeaux",
      city: "Bordeaux",
      department: "33",
      property_type: "apartment",
      media: [],
      source_name: "AGRASC",
      source_url: "https://agrasc.gouv.fr/vente/1",
    } as unknown as AuctionSale;
    const projection: AiReviewProjectionReadModel = {
      auction_sale_id: sale.id,
      field_key: "property.city",
      review_state: "unresolved",
      citation_status: "not_required",
      is_publishable: false,
      source_name: "AGRASC",
      source_url: "https://agrasc.gouv.fr/vente/1",
    };

    render(
      <QueryClientProvider client={new QueryClient()}>
        <ListingCard
          sale={sale}
          aiReviewProjections={[projection]}
          returnTo="/sales"
          locked={false}
          analysisLocked={false}
          active={false}
          onHover={vi.fn()}
          onSelect={vi.fn()}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Partager cette vente" }));
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ title: "Appartement" }));
    expect(share.mock.calls[0]?.[0]?.title).not.toContain("Bordeaux");
  });
});

describe("listing media gallery", () => {
  const mediaSale = {
    id: "sale-gallery",
    city: "Bordeaux",
    property_type: "apartment",
    media: [
      { type: "image", url: "https://cdn.example.com/property-living-room.jpg" },
      { type: "image", url: "https://cdn.example.com/property-bedroom.jpg" },
    ],
  } as unknown as AuctionSale;

  it("changes supplied photos with arrows and keyboard without selecting the card", () => {
    const onSelect = vi.fn();
    render(
      <ListingMediaCarousel
        sale={mediaSale}
        locked={false}
        title="Appartement à Bordeaux"
        onSelect={onSelect}
      />,
    );

    expect(
      screen.getByRole("img", { name: "Appartement à Bordeaux", hidden: true }).getAttribute("src"),
    ).toBe("https://cdn.example.com/property-living-room.jpg");
    fireEvent.click(screen.getByRole("button", { name: "Photo suivante" }));
    expect(screen.getByText("2 / 2")).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Appartement à Bordeaux", hidden: true }).getAttribute("src"),
    ).toBe("https://cdn.example.com/property-bedroom.jpg");
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByTestId("sale-media-carousel-sale-gallery"), {
      key: "ArrowLeft",
    });
    expect(screen.getByText("1 / 2")).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("recognizes a horizontal touch swipe and suppresses the following card link click", () => {
    const onSelect = vi.fn();
    render(
      <ListingMediaCarousel
        sale={mediaSale}
        locked={false}
        title="Appartement à Bordeaux"
        onSelect={onSelect}
      />,
    );
    const carousel = screen.getByTestId("sale-media-carousel-sale-gallery");
    const image = screen.getByRole("img", { name: "Appartement à Bordeaux", hidden: true });

    fireEvent.pointerDown(carousel, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 140,
      clientY: 100,
      button: 0,
    });
    fireEvent.pointerUp(carousel, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 60,
      clientY: 104,
    });
    expect(screen.getByText("2 / 2")).toBeTruthy();

    fireEvent.click(image);
    expect(onSelect).not.toHaveBeenCalled();
  });

  describe("copie hébergée de la photo principale", () => {
    const MIRROR_URL =
      "https://ci.supabase.co/storage/v1/object/public/sale-photos/sale-gallery/a-640.webp";
    const SOURCE = "https://www.licitor.com/photos/property-living-room.jpg";
    const mirroredSale = {
      ...mediaSale,
      id: "sale-mirrored",
      media: [
        {
          type: "image",
          url: SOURCE,
          mirror: {
            path640: "sale-gallery/a-640.webp",
            path1600: "sale-gallery/a-1600.webp",
            width: 1600,
            height: 1200,
          },
        },
      ],
    } as unknown as AuctionSale;

    beforeEach(() => vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ci.supabase.co"));
    afterEach(() => vi.unstubAllEnvs());

    it("affiche la copie 640 px telle quelle, sans optimiseur", () => {
      render(<ListingMediaCarousel sale={mirroredSale} locked={false} title="Appartement" />);

      const image = screen.getByRole("img", { name: "Appartement", hidden: true });
      expect(image.getAttribute("src")).toBe(MIRROR_URL);
      expect(image.getAttribute("src")).not.toContain("/_next/image");
    });

    it("retombe sur la source si la copie échoue, puis sur le visuel de repli", async () => {
      render(<ListingMediaCarousel sale={mirroredSale} locked={false} title="Appartement" />);

      fireEvent.error(screen.getByRole("img", { name: "Appartement", hidden: true }));
      const source = await screen.findByRole("img", { name: "Appartement", hidden: true });
      expect(source.getAttribute("src")).toBe(SOURCE);

      fireEvent.error(source);
      expect(await screen.findByTestId("sale-media-fallback-sale-mirrored")).toBeTruthy();
    });

    it("ne rejette pas la copie 640 px sur sa taille rendue (l'original a déjà été jugé)", async () => {
      vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(640);
      vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(230);
      try {
        render(<ListingMediaCarousel sale={mirroredSale} locked={false} title="Appartement" />);
        fireEvent.load(screen.getByRole("img", { name: "Appartement", hidden: true }));

        expect(screen.queryByTestId("sale-media-fallback-sale-mirrored")).toBeNull();
        expect(
          screen.getByRole("img", { name: "Appartement", hidden: true }).getAttribute("src"),
        ).toBe(MIRROR_URL);
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  it("keeps SaleVisual as the fallback when no usable property photo exists", () => {
    render(
      <ListingMediaCarousel
        sale={{ ...mediaSale, id: "sale-no-photo", media: [] } as unknown as AuctionSale}
        locked={false}
        title="Appartement à Bordeaux"
      />,
    );

    expect(screen.getByTestId("sale-media-fallback-sale-no-photo")).toBeTruthy();
    expect(screen.getByText("Visuel : Appartement à Bordeaux")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Photo suivante" })).toBeNull();
  });

  it("asks SaleVisual for a light 320×240 map thumbnail framed like the former 512×384", () => {
    render(
      <ListingMediaCarousel
        sale={{ ...mediaSale, id: "sale-no-photo", media: [] } as unknown as AuctionSale}
        locked={false}
        title="Appartement à Bordeaux"
      />,
    );

    const visual = screen.getByTestId("sale-visual");
    expect(visual.getAttribute("data-thumbnail")).toBe("true");
    expect(visual.getAttribute("data-map-size")).toBe("320x240");
    expect(visual.getAttribute("data-map-framing")).toBe("512");
  });
});

describe("structure et noms de la liste des résultats", () => {
  it("place un h2 masqué « Résultats » avant les cartes (h1, h2, puis h3)", () => {
    const { container } = renderResults([sale("sale-a")]);
    const h2 = screen.getByRole("heading", { level: 2, name: "Résultats" });
    expect(h2.className).toContain("sr-only");
    const h3 = screen.getByRole("heading", { level: 3 });
    expect(h2.compareDocumentPosition(h3) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll("h2")).toHaveLength(1);
  });

  it("n'ajoute pas ce h2 à un état vide", () => {
    renderResults([]);
    expect(screen.queryByRole("heading", { name: "Résultats" })).toBeNull();
  });

  it("complète le nom du lien de la carte par le prix, pour ne pas multiplier les homonymes", () => {
    renderResults([
      { ...sale("sale-a"), starting_price_eur: 90_000 } as AuctionSale,
      { ...sale("sale-b"), starting_price_eur: 120_000 } as AuctionSale,
    ]);
    const names = Array.from(document.querySelectorAll("[id^='sale-card-']")).map((link) =>
      link.getAttribute("aria-label"),
    );
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^Voir .+, 90\s000\s€$/);
    expect(names[1]).toMatch(/^Voir .+, 120\s000\s€$/);
    expect(new Set(names).size).toBe(2);
  });

  it("prend la date quand le prix manque, sans jamais nommer une valeur masquée", () => {
    renderResults([
      {
        ...sale("sale-a"),
        starting_price_eur: null,
        sale_date: "2099-03-12T09:00:00Z",
      } as AuctionSale,
    ]);
    expect(document.getElementById("sale-card-sale-a")?.getAttribute("aria-label")).toMatch(
      /^Voir .+, vente le .*mars 2099$/,
    );
  });
});

describe("result cards off screen", () => {
  it("skips the rendering of cards off screen but keeps the id the map scrolls to", () => {
    renderResults([sale("sale-a"), sale("sale-b")]);

    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.className).toContain("[content-visibility:auto]");
      expect(card.className).toContain("[contain-intrinsic-size:none_auto_28rem]");
    }
    expect(document.getElementById("sale-card-sale-a")).toBeTruthy();
    expect(cards[0].contains(document.getElementById("sale-card-sale-a"))).toBe(true);
    expect(cards[1].contains(document.getElementById("sale-card-sale-b"))).toBe(true);
  });
});

describe("« 3 déblocages par mois » on the cards of a Découverte account", () => {
  const renderForDiscoveryAccount = (sales: AuctionSale[]) =>
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <SearchResultsList
          sales={sales}
          returnTo="/sales"
          locked={false}
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
        />
      </QueryClientProvider>,
    );

  it("marks the sales the account unlocked and sells the unlocks on the others", async () => {
    setAuthenticatedUser("user-a");
    testState.favoriteQuery.in.mockResolvedValue({ data: [], error: null });
    testState.unlocksOverview.mockResolvedValue({ status: {}, sales: [{ id: "sale-b" }] });

    renderForDiscoveryAccount([tribunalSale("sale-a"), tribunalSale("sale-b")]);

    expect(await screen.findAllByText("Débloquée")).toHaveLength(1);
    const cards = screen.getAllByRole("article");
    expect(cards[1].textContent).toContain("Débloquée");
    // La carte entière mène à la fiche : « Voir le détail » ne s'écrit plus en bas de carte.
    expect(cards[1].textContent).not.toContain("Voir le détail");
    expect(cards[0].textContent).not.toContain("Débloquée");
    expect(cards[0].textContent).toContain(
      "Gratuit, sans carte bancaire · 3 déblocages par mois",
    );
    expect(document.body.textContent).not.toContain("Analyse détaillée avec l’offre Analyse");
  });

  it("sells the unlocks on the sales that have a fee regime (court, notary), not on a domanial sale", async () => {
    setAuthenticatedUser("user-a");
    testState.favoriteQuery.in.mockResolvedValue({ data: [], error: null });
    testState.unlocksOverview.mockResolvedValue({ status: {}, sales: [] });

    renderForDiscoveryAccount([
      tribunalSale("sale-a"),
      { ...sale("sale-b"), sale_venue_type: "notary" } as unknown as AuctionSale,
      { ...sale("sale-c"), sale_venue_type: "state" } as unknown as AuctionSale,
    ]);

    await waitFor(() => expect(testState.unlocksOverview).toHaveBeenCalled());
    const cards = screen.getAllByRole("article");
    expect(cards[0].textContent).toContain(
      "Gratuit, sans carte bancaire · 3 déblocages par mois",
    );
    expect(cards[1].textContent).toContain(
      "Gratuit, sans carte bancaire · 3 déblocages par mois",
    );
    expect(cards[2].textContent).not.toContain("déblocages par mois");
  });

  it("does not ask for the unlocks of a visitor or of an Analyse account", async () => {
    renderResults([sale("sale-a")]);
    setAuthenticatedUser("user-a");
    testState.favoriteQuery.in.mockResolvedValue({ data: [], error: null });
    renderResults([sale("sale-a")]);
    await waitFor(() => expect(testState.favoriteQuery.in).toHaveBeenCalled());
    expect(testState.unlocksOverview).not.toHaveBeenCalled();
    expect(screen.queryByText("Débloquée")).toBeNull();
  });

  it("keeps the cards as they were when the unlocks cannot be read", async () => {
    setAuthenticatedUser("user-a");
    testState.favoriteQuery.in.mockResolvedValue({ data: [], error: null });
    testState.unlocksOverview.mockRejectedValue(new Error("indisponible"));

    renderForDiscoveryAccount([tribunalSale("sale-a")]);

    await waitFor(() => expect(testState.unlocksOverview).toHaveBeenCalled());
    expect(screen.queryByText("Débloquée")).toBeNull();
    expect(screen.getByRole("article").textContent).toContain(
      "Gratuit, sans carte bancaire · 3 déblocages par mois",
    );
  });
});

describe("optional catalogue placement", () => {
  it("renders a sponsored placement after four listings without adding a listing card", () => {
    const sales = ["a", "b", "c", "d"].map(
      (id) =>
        ({
          id,
          city: id,
          property_type: "apartment",
          media: [],
        }) as unknown as AuctionSale,
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <SearchResultsList
          sales={sales}
          sponsoredPlacement={<div data-testid="sponsored-placement">Partenaire</div>}
          returnTo="/sales"
          locked
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
        />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("sponsored-placement")).toBeTruthy();
    expect(screen.getAllByRole("article")).toHaveLength(4);
  });
});

describe("catalogue favorite status", () => {
  it("loads favorite status for all visible cards with one batched read", async () => {
    setAuthenticatedUser("user-a");
    testState.favoriteQuery.in.mockResolvedValue({
      data: [{ sale_id: "sale-a" }],
      error: null,
    });

    const { client } = renderResults([sale("sale-a"), sale("sale-b"), sale("sale-c")]);

    await waitFor(() => expect(testState.favoriteQuery.in).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        client.getQueryData(["search-favorite-status", "user-a", ["sale-a", "sale-b", "sale-c"]]),
      ).toEqual(["sale-a"]),
    );
    expect(testState.favoriteQuery.in).toHaveBeenCalledWith("sale_id", [
      "sale-a",
      "sale-b",
      "sale-c",
    ]);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retirer des favoris" })).toBeTruthy(),
    );
    expect(screen.getAllByRole("button", { name: "Ajouter aux favoris" })).toHaveLength(2);
  });

  it("updates the batched cache after a toggle and reuses it on remount", async () => {
    setAuthenticatedUser("user-a");
    testState.favoriteQuery.in
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: [{ sale_id: "sale-a" }], error: null });

    const sales = [sale("sale-a")];
    const { client } = renderResults(sales);
    await waitFor(() => expect(testState.favoriteQuery.in).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Ajouter aux favoris" }));
    await waitFor(() =>
      expect(testState.addFavoriteSale).toHaveBeenCalledWith({ data: { saleId: "sale-a" } }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retirer des favoris" })).toBeTruthy(),
    );
    expect(client.getQueryData(["search-favorite-status", "user-a", ["sale-a"]])).toEqual([
      "sale-a",
    ]);

    cleanup();
    renderResults(sales, client);
    expect(screen.getByRole("button", { name: "Retirer des favoris" })).toBeTruthy();
    expect(testState.favoriteQuery.in).toHaveBeenCalledTimes(2);
  });

  it("ignores a late favorite response from the previous account", async () => {
    setAuthenticatedUser("user-a");
    let resolveUserA!: (result: { data: { sale_id: string }[]; error: null }) => void;
    const userARead = new Promise<{ data: { sale_id: string }[]; error: null }>((resolve) => {
      resolveUserA = resolve;
    });
    testState.favoriteQuery.in
      .mockImplementationOnce(() => userARead)
      .mockResolvedValueOnce({ data: [], error: null });

    const sales = [sale("sale-a")];
    const view = renderResults(sales);
    await waitFor(() => expect(testState.favoriteQuery.in).toHaveBeenCalledOnce());

    setAuthenticatedUser("user-b");
    view.rerender(
      <QueryClientProvider client={view.client}>
        <SearchResultsList
          sales={sales}
          returnTo="/sales"
          locked={false}
          analysisLocked={false}
          isLoading={false}
          error={null}
          selectedSaleId={null}
          hoveredSaleId={null}
          onHover={vi.fn()}
          onSelect={vi.fn()}
          comparedSaleIds={[]}
          comparisonDisabled={false}
          onToggleComparison={vi.fn()}
        />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(testState.favoriteQuery.in).toHaveBeenCalledTimes(2));

    resolveUserA({ data: [{ sale_id: "sale-a" }], error: null });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Ajouter aux favoris" })).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: "Retirer des favoris" })).toBeNull();
  });

  it("cancels the first read before a toggle so its stale response cannot undo the new state", async () => {
    setAuthenticatedUser("user-a");
    let resolveAdd!: () => void;
    let resolveInitial!: (result: { data: { sale_id: string }[]; error: null }) => void;
    let resolveRefresh!: (result: { data: { sale_id: string }[]; error: null }) => void;
    const initialRead = new Promise<{ data: { sale_id: string }[]; error: null }>((resolve) => {
      resolveInitial = resolve;
    });
    const refreshedRead = new Promise<{ data: { sale_id: string }[]; error: null }>((resolve) => {
      resolveRefresh = resolve;
    });
    testState.favoriteQuery.in
      .mockImplementationOnce(() => initialRead)
      .mockImplementationOnce(() => refreshedRead);
    testState.addFavoriteSale.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveAdd = resolve;
        }),
    );

    const sales = [sale("sale-a")];
    const { client } = renderResults(sales);
    await waitFor(() => expect(testState.favoriteQuery.in).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Ajouter aux favoris" }));
    await waitFor(() => expect(testState.addFavoriteSale).toHaveBeenCalledOnce());

    resolveInitial({ data: [], error: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.getQueryData(["search-favorite-status", "user-a", ["sale-a"]])).toBeUndefined();

    resolveAdd();
    await waitFor(() => expect(testState.favoriteQuery.in).toHaveBeenCalledTimes(2));

    resolveRefresh({ data: [{ sale_id: "sale-a" }], error: null });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retirer des favoris" })).toBeTruthy(),
    );

    resolveInitial({ data: [], error: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole("button", { name: "Retirer des favoris" })).toBeTruthy();
  });
});

describe("favourite heart for a visitor", () => {
  function renderAnonymous() {
    window.history.pushState({}, "", "/sales?city=Lyon");
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <SearchResultsList
          sales={[sale("sale-a")]}
          returnTo="/sales"
          locked
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
        />
      </QueryClientProvider>,
    );
  }

  it("keeps the heart and explains the free account instead of showing a padlock", () => {
    renderAnonymous();
    const heart = screen.getByRole("button", { name: "Ajouter aux favoris" });
    expect(heart.getAttribute("title")).toBe(
      "Créer un compte gratuit pour garder cette vente (10 favoris)",
    );
    expect(heart.className).toContain("h-11");
  });

  it("opens the sign-up page with the favourite reason and comes back to the search", () => {
    renderAnonymous();
    fireEvent.click(screen.getByRole("button", { name: "Ajouter aux favoris" }));
    expect(testState.push).toHaveBeenCalledWith(
      "/login?redirect=%2Fsales%3Fcity%3DLyon&mode=investor&reason=favori",
    );
  });
});

describe("repère « Pépite » des cartes", () => {
  const pepiteSale = { ...sale("pepite-1"), starting_price_eur: 90_000 } as AuctionSale;

  it("pose la pastille sur la photo, en haut à gauche, et ajoute « , pépite » au nom du lien", () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <SearchResultsList
          sales={[pepiteSale, sale("autre")]}
          returnTo="/sales"
          locked={false}
          analysisLocked={false}
          isLoading={false}
          error={null}
          selectedSaleId={null}
          hoveredSaleId={null}
          onHover={vi.fn()}
          onSelect={vi.fn()}
          comparedSaleIds={[]}
          comparisonDisabled={false}
          onToggleComparison={vi.fn()}
          pepiteSaleIds={new Set(["pepite-1"])}
        />
      </QueryClientProvider>,
    );
    const badges = screen.getAllByTestId("pepite-badge");
    expect(badges).toHaveLength(1);
    const overlay = badges[0].closest("div.absolute");
    expect(overlay?.className).toMatch(/left-3/);
    expect(overlay?.className).toMatch(/top-3/);
    // Sur la photo (zone d'image), pas dans le corps de la carte.
    expect(overlay?.parentElement?.className).toMatch(/aspect-\[4\/3\]/);
    const links = container.querySelectorAll("a[id^='sale-card-']");
    expect(links[0].getAttribute("aria-label")).toMatch(/, pépite$/);
    expect(links[1].getAttribute("aria-label")).not.toMatch(/pépite/);
    // Pas de lien d'appel au déblocage sur la carte.
    expect(container.textContent).not.toMatch(/Débloquer|déblocage/i);
  });

  it("une pépite dans le périmètre d'un PPRi affiche la mention courte, dans la carte et dans le nom du lien", () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <SearchResultsList
          sales={[pepiteSale, { ...sale("autre") } as AuctionSale]}
          returnTo="/sales"
          locked={false}
          analysisLocked={false}
          isLoading={false}
          error={null}
          selectedSaleId={null}
          hoveredSaleId={null}
          onHover={vi.fn()}
          onSelect={vi.fn()}
          comparedSaleIds={[]}
          comparisonDisabled={false}
          onToggleComparison={vi.fn()}
          pepiteSaleIds={new Set(["pepite-1"])}
          pepiteExposedSaleIds={new Set(["pepite-1", "autre"])}
        />
      </QueryClientProvider>,
    );
    // Seule la pépite est concernée : une vente « exposée » qui n'est pas une pépite n'affiche rien.
    const notes = screen.getAllByTestId("pepite-flood-exposed");
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toContain("zonage à vérifier");
    expect(notes[0].closest("article")?.querySelector("h3")).toBeTruthy();
    const links = container.querySelectorAll("a[id^='sale-card-']");
    expect(links[0].getAttribute("aria-label")).toMatch(/zonage à vérifier\.$/);
    expect(links[1].getAttribute("aria-label")).not.toMatch(/zonage/);
  });

  it("n'ajoute rien sans liste de pépites (mode shadow) : la carte est celle d'avant", () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ListingCard
          sale={pepiteSale}
          returnTo="/sales"
          locked={false}
          analysisLocked={false}
          active={false}
          onHover={vi.fn()}
          onSelect={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("pepite-badge")).toBeNull();
    expect(container.textContent).not.toMatch(/pépite/i);
  });

  it("garde deux pastilles au plus dans le corps de la carte (la pépite est sur la photo)", () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ListingCard
          sale={pepiteSale}
          returnTo="/sales"
          locked={false}
          analysisLocked={false}
          active={false}
          onHover={vi.fn()}
          onSelect={vi.fn()}
          pepite
        />
      </QueryClientProvider>,
    );
    const body = container.querySelector("div.relative.min-w-0.p-4");
    expect(body?.querySelector("[data-testid='pepite-badge']")).toBeNull();
  });

  it("n'y place aucun encart sponsorisé : l'encart reste en fin de liste, séparé", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SearchResultsList
          sales={["a", "b", "c", "pepite-1"].map((id) => ({ ...sale(id) }) as AuctionSale)}
          returnTo="/sales"
          locked={false}
          analysisLocked={false}
          isLoading={false}
          error={null}
          selectedSaleId={null}
          hoveredSaleId={null}
          onHover={vi.fn()}
          onSelect={vi.fn()}
          comparedSaleIds={[]}
          comparisonDisabled={false}
          onToggleComparison={vi.fn()}
          pepiteSaleIds={new Set(["pepite-1"])}
          sponsoredPlacement={<aside data-testid="sponsored">Publicité · Sponsorisé</aside>}
        />
      </QueryClientProvider>,
    );
    const placement = screen.getByTestId("sponsored");
    expect(placement.closest("article")).toBeNull();
    for (const article of screen.getAllByRole("article")) {
      expect(article.contains(placement)).toBe(false);
    }
    // Après la dernière carte, jamais entre deux annonces.
    const cards = screen.getAllByRole("article");
    expect(
      cards[cards.length - 1].compareDocumentPosition(placement) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("l'état vide du filtre « Pépites seulement » parle des pépites et propose trois actions", () => {
    const onKeepOnlyPepite = vi.fn();
    const onAlert = vi.fn();
    const onShowFrance = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SearchResultsList
          sales={[]}
          returnTo="/sales"
          locked={false}
          analysisLocked={false}
          isLoading={false}
          error={null}
          selectedSaleId={null}
          hoveredSaleId={null}
          onHover={vi.fn()}
          onSelect={vi.fn()}
          comparedSaleIds={[]}
          comparisonDisabled={false}
          onToggleComparison={vi.fn()}
          activeFilters={[
            { key: "city", label: "Pau", clear: { city: undefined } },
            { key: "pepite", label: "Pépites seulement", clear: { pepite: undefined } },
          ]}
          onRemoveFilter={vi.fn()}
          onShowFrance={onShowFrance}
          pepiteEmpty={{ count: 12, onKeepOnlyPepite, onAlert }}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Aucune pépite avec ces critères pour le moment.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retirer les autres filtres" }));
    fireEvent.click(screen.getByRole("button", { name: "Élargir à la France" }));
    fireEvent.click(screen.getByRole("button", { name: "Me prévenir dès qu’une pépite apparaît" }));
    expect(onKeepOnlyPepite).toHaveBeenCalledTimes(1);
    expect(onShowFrance).toHaveBeenCalledTimes(1);
    expect(onAlert).toHaveBeenCalledTimes(1);
  });
});

describe("pastilles sur la photo : deux au plus", () => {
  function renderCard(props: { pepite?: boolean; unlocked?: boolean }) {
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <ListingCard
          sale={{ ...sale("viewed-1"), starting_price_eur: 90_000 } as AuctionSale}
          returnTo="/sales"
          locked={false}
          analysisLocked={false}
          active={false}
          onHover={vi.fn()}
          onSelect={vi.fn()}
          {...props}
        />
      </QueryClientProvider>,
    );
  }
  const photoBadges = (container: HTMLElement) =>
    container.querySelector("div.absolute.left-3.top-3")?.children.length ?? 0;

  it("« Vu » disparaît quand « Pépite » et « Débloquée » s'appliquent ensemble", () => {
    viewedState.viewed = true;
    const both = renderCard({ pepite: true, unlocked: true });
    expect(photoBadges(both.container)).toBe(2);
    expect(screen.queryByText("Vu")).toBeNull();
    expect(screen.getByText("Débloquée")).toBeTruthy();
    expect(screen.getByTestId("pepite-badge")).toBeTruthy();
    both.unmount();

    // Deux pastilles au plus aussi dans les autres combinaisons.
    const pepiteViewed = renderCard({ pepite: true });
    expect(photoBadges(pepiteViewed.container)).toBe(2);
    expect(screen.getByText("Vu")).toBeTruthy();
    pepiteViewed.unmount();

    const unlockedViewed = renderCard({ unlocked: true });
    expect(photoBadges(unlockedViewed.container)).toBe(2);
  });
});
