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
vi.mock("@/hooks/use-viewed-sales", () => ({ useViewedSales: () => ({ isViewed: () => false }) }));
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
    expect(screen.getByRole("heading", { name: "Appartement · Bordeaux" })).toBeTruthy();
    expect(screen.getByText(/Département 33 · 60\s*m²/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Définition : mise à prix" })).toBeTruthy();
    expect(screen.getByText("Mise à prix").className).not.toContain("text-xs");
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
      screen.getByText("Gratuit, sans carte bancaire · 3 fiches détaillées par mois"),
    ).toBeTruthy();
  });

  it("titles the card « Type de bien · Ville » with a clean fallback when one is missing", () => {
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
    expect(screen.getByRole("heading", { name: "Maison · Lille" })).toBeTruthy();
    cleanup();

    // Unknown type: « Bien », never an internal code.
    renderCard({ property_type: "other", city: "Lille", department: "59" });
    expect(screen.getByRole("heading", { name: "Bien · Lille" })).toBeTruthy();
    cleanup();

    // No city: the type alone, the department takes over below the title.
    renderCard({ property_type: "apartment", city: null, department: "Gironde" });
    expect(screen.getByRole("heading", { name: "Appartement" })).toBeTruthy();
    expect(screen.getByText(/^Gironde · /)).toBeTruthy();
    cleanup();

    // Neither city nor department: say so rather than leave a hole.
    renderCard({ property_type: "apartment", city: "  ", department: null });
    expect(screen.getByRole("heading", { name: "Appartement" })).toBeTruthy();
    expect(screen.getByText(/^Localisation à préciser · /)).toBeTruthy();
  });

  it("keeps the old reassurance on a locked sale that cannot be unlocked", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ListingCard
          sale={
            {
              id: "sale-notary",
              city: "Lyon",
              property_type: "apartment",
              sale_venue_type: "notary",
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
    expect(screen.queryByText(/fiches détaillées par mois/)).toBeNull();
  });

  it("signale « Annonce bien renseignée » sur les seules cartes du palier haut", () => {
    const renderCard = (completeness_tier: number | null | undefined, locked: boolean) =>
      render(
        <QueryClientProvider client={new QueryClient()}>
          <ListingCard
            sale={{ ...sale("tier-card"), completeness_tier } as AuctionSale}
            returnTo="/sales"
            locked={locked}
            analysisLocked={false}
            active={false}
            onHover={vi.fn()}
            onSelect={vi.fn()}
          />
        </QueryClientProvider>,
      );

    renderCard(1, true);
    expect(screen.getByText("Annonce bien renseignée")).toBeTruthy();
    cleanup();
    renderCard(1, false);
    expect(screen.getByText("Annonce bien renseignée")).toBeTruthy();
    cleanup();
    for (const tier of [0, null, undefined]) {
      renderCard(tier, false);
      expect(screen.queryByText("Annonce bien renseignée")).toBeNull();
      cleanup();
    }
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
      "Source : AGRASC · Bordeaux",
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
    expect(cards[1].textContent).toContain("Voir le détail");
    expect(cards[0].textContent).not.toContain("Débloquée");
    expect(cards[0].textContent).toContain(
      "Gratuit, sans carte bancaire · 3 fiches détaillées par mois",
    );
    expect(document.body.textContent).not.toContain("Analyse détaillée avec l’offre Analyse");
  });

  it("sells the unlocks only on the sales held at a court", async () => {
    setAuthenticatedUser("user-a");
    testState.favoriteQuery.in.mockResolvedValue({ data: [], error: null });
    testState.unlocksOverview.mockResolvedValue({ status: {}, sales: [] });

    renderForDiscoveryAccount([
      tribunalSale("sale-a"),
      { ...sale("sale-b"), sale_venue_type: "notary" } as unknown as AuctionSale,
    ]);

    await waitFor(() => expect(testState.unlocksOverview).toHaveBeenCalled());
    const cards = screen.getAllByRole("article");
    expect(cards[0].textContent).toContain(
      "Gratuit, sans carte bancaire · 3 fiches détaillées par mois",
    );
    expect(cards[1].textContent).not.toContain("fiches détaillées par mois");
    expect(cards[1].textContent).toContain("Voir le détail");
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
      "Gratuit, sans carte bancaire · 3 fiches détaillées par mois",
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
