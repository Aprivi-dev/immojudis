// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiReviewProjectionReadModel } from "@/lib/ai-review-guard";
import { formatStartingPrice } from "@/lib/format";
import { LAUNCH_OFFER_VISITOR_TEXT } from "@/lib/launch-offer";
import { FREE_ACCESS_LINE } from "@/lib/sale-unlocks";
import type { AuctionSale } from "@/lib/types";
import { ListingCard, SearchResultsList } from "./SearchResults";
import { listingAccessLine } from "./listing-text";

const testState = vi.hoisted(() => {
  const favoriteQuery = { select: vi.fn(), eq: vi.fn(), in: vi.fn() };
  favoriteQuery.select.mockReturnValue(favoriteQuery);
  favoriteQuery.eq.mockReturnValue(favoriteQuery);
  return {
    auth: { current: { user: null as { id: string } | null, loading: false } },
    favoriteQuery,
    supabase: { from: vi.fn(() => favoriteQuery) },
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
  SaleVisual: () => <div data-testid="sale-visual" />,
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

function makeSale(id: string, fields: Record<string, unknown> = {}): AuctionSale {
  return {
    id,
    city: "Bordeaux",
    department: "33",
    property_type: "apartment",
    starting_price_eur: 90_000,
    sale_date: "2099-10-20T09:00:00Z",
    app_surface_m2: 60,
    app_surface_kind: "habitable",
    sale_venue_type: "tribunal",
    media: [],
    ...fields,
  } as unknown as AuctionSale;
}

type ListProps = Partial<React.ComponentProps<typeof SearchResultsList>>;

function renderTable(sales: AuctionSale[], props: ListProps = {}) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
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
        view="table"
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe("vue « tableau » des résultats", () => {
  it("est un vrai tableau, avec légende masquée et en-têtes de colonne", () => {
    const { container } = renderTable([makeSale("sale-a")]);

    const table = screen.getByRole("table");
    const caption = table.querySelector("caption");
    expect(caption?.className).toContain("sr-only");
    expect(caption?.textContent).toMatch(/commune/i);

    const headers = Array.from(table.querySelectorAll("thead th"));
    expect(headers.every((th) => th.getAttribute("scope") === "col")).toBe(true);
    expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Commune",
      "Type de bien",
      "Surface",
      "Prix",
      "Date de vente",
      "Statut",
      "Favori",
    ]);
    // Le nom de la commune est l'en-tête de sa ligne.
    expect(screen.getByRole("rowheader").getAttribute("scope")).toBe("row");
    // Pas de photo, pas de carte.
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByTestId("sale-visual")).toBeNull();
    expect(screen.queryAllByRole("article")).toHaveLength(0);
  });

  it("affiche commune, département, type, surface, prix, date et statut de chaque annonce", () => {
    renderTable([makeSale("sale-a"), makeSale("sale-b", { city: "Lyon", department: "69" })]);

    const rows = within(screen.getAllByRole("rowgroup")[1]).getAllByRole("row");
    expect(rows).toHaveLength(2);
    const first = rows[0];
    expect(first.textContent).toContain("Bordeaux");
    expect(first.textContent).toContain("Département 33");
    expect(first.textContent).toContain("Appartement");
    expect(first.textContent).toMatch(/60\s*m²/);
    expect(first.textContent).toContain(formatStartingPrice(90_000));
    expect(first.textContent).toContain("20 octobre 2099");
    expect(first.textContent).toContain("Vente au tribunal");
    expect(rows[1].textContent).toContain("Lyon");
    expect(rows[1].textContent).toContain("Département 69");
  });

  it("renvoie chaque ligne vers sa fiche par le lien de la commune", () => {
    const onSelect = vi.fn();
    renderTable([makeSale("sale-a"), makeSale("sale-b")], {
      returnTo: "/sales?city=Bordeaux&view=table",
      onSelect,
    });

    const links = screen.getAllByRole("link", { name: /^Voir / });
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute("href")).toBe(
      "/sales/sale-a?from=%2Fsales%3Fcity%3DBordeaux%26view%3Dtable",
    );
    expect(links[0].getAttribute("id")).toBe("sale-card-sale-a");
    links[1].addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(links[1]);
    expect(onSelect).toHaveBeenCalledWith("sale-b");
  });

  it("dit « Mise à prix » et « Audience » au tribunal", () => {
    renderTable([makeSale("sale-a")]);
    const row = screen.getAllByRole("row")[1];
    expect(row.textContent).toContain("Mise à prix");
    expect(row.textContent).not.toContain("Prix publié");
    expect(within(row).getByText("Audience")).toBeTruthy();
  });

  it("dit « Prix publié » sans « Audience » hors tribunal", () => {
    renderTable([
      makeSale("sale-notary", { sale_venue_type: "notary" }),
      makeSale("sale-state", { sale_venue_type: "state" }),
    ]);
    for (const row of screen.getAllByRole("row").slice(1)) {
      expect(row.textContent).toContain("Prix publié");
      expect(row.textContent).not.toContain("Mise à prix");
      expect(row.textContent).not.toContain("Audience");
    }
  });

  it("garde les mentions de la carte quand une valeur manque", () => {
    renderTable([
      makeSale("sale-a", {
        starting_price_eur: 0,
        app_surface_m2: null,
        city: null,
        sale_date: null,
        sale_venue_type: "notary",
      }),
    ]);
    const row = screen.getAllByRole("row")[1];
    expect(row.textContent).toContain(formatStartingPrice(0));
    expect(row.textContent).toContain("Surface n.c.");
    expect(row.textContent).toContain("Localisation à préciser");
    expect(row.textContent).toContain("Date à confirmer");
  });

  it("n'affiche pas un champ bloqué par la relecture IA, comme la carte", () => {
    const sale = makeSale("sale-ai", { source_name: "AGRASC", source_url: "https://a.fr/1" });
    const projection: AiReviewProjectionReadModel = {
      auction_sale_id: sale.id,
      field_key: "property.property_type",
      review_state: "unresolved",
      citation_status: "not_required",
      is_publishable: false,
      source_name: "AGRASC",
      source_url: "https://a.fr/1",
    };
    renderTable([sale], {
      aiReviewBySaleId: { [sale.id]: [projection] },
      aiReviewStatus: "ready",
    });

    const row = screen.getAllByRole("row")[1];
    expect(within(row).getByText("Type de bien à confirmer")).toBeTruthy();
    expect(row.textContent).not.toContain("Appartement");
    // Le nom accessible du lien suit la règle du titre de carte.
    expect(within(row).getByRole("link").getAttribute("aria-label")).toBe(
      "Voir À confirmer à Bordeaux",
    );
  });

  it("applique les règles d'accès de la carte : mêmes lignes pour un visiteur", () => {
    const tribunal = makeSale("sale-t");
    const notary = makeSale("sale-n", { sale_venue_type: "notary" });
    renderTable([tribunal, notary], { locked: true, analysisLocked: true });

    const [rowT, rowN] = screen.getAllByRole("row").slice(1);
    expect(rowT.textContent).toContain(FREE_ACCESS_LINE);
    expect(rowN.textContent).toContain("Fiche complète avec un compte gratuit");

    cleanup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        {[tribunal, notary].map((sale) => (
          <ListingCard
            key={sale.id}
            sale={sale}
            returnTo="/sales"
            locked
            analysisLocked
            active={false}
            onHover={vi.fn()}
            onSelect={vi.fn()}
          />
        ))}
      </QueryClientProvider>,
    );
    const [cardT, cardN] = screen.getAllByRole("article");
    expect(cardT.textContent).toContain(FREE_ACCESS_LINE);
    expect(cardN.textContent).toContain("Fiche complète avec un compte gratuit");
  });

  it("ne montre ni statut d'occupation ni donnée réservée que la carte cache", () => {
    renderTable([makeSale("sale-a", { occupancy_status: "occupied", investment_score: 78 })], {
      locked: true,
      analysisLocked: true,
    });
    const text = screen.getByRole("table").textContent ?? "";
    expect(text).not.toMatch(/occup/i);
    expect(text).not.toContain("78");
  });

  it("choisit la ligne d'accès par un seul helper, partagé avec la carte", () => {
    const tribunal = makeSale("sale-t");
    const notary = makeSale("sale-n", { sale_venue_type: "notary" });
    const open = { locked: false, analysisLocked: false, unlocked: false };
    expect(listingAccessLine(tribunal, open)).toBe("Voir le détail");
    expect(listingAccessLine(tribunal, { ...open, analysisLocked: true })).toBe(FREE_ACCESS_LINE);
    expect(listingAccessLine(tribunal, { ...open, analysisLocked: true, unlocked: true })).toBe(
      "Voir le détail",
    );
    expect(listingAccessLine(notary, { ...open, analysisLocked: true })).toBe("Voir le détail");
    expect(listingAccessLine(notary, { ...open, locked: true })).toBe(
      "Fiche complète avec un compte gratuit",
    );
  });

  it("offre de lancement : le visiteur lit la mention de l'offre, pour toutes les ventes", () => {
    const tribunal = makeSale("sale-t");
    const notary = makeSale("sale-n", { sale_venue_type: "notary" });
    const visitor = { locked: true, analysisLocked: true, unlocked: false, launchOffer: true };
    expect(listingAccessLine(tribunal, visitor)).toBe(LAUNCH_OFFER_VISITOR_TEXT);
    expect(listingAccessLine(notary, visitor)).toBe(LAUNCH_OFFER_VISITOR_TEXT);
    // Hors offre, ou pour un compte connecté, la ligne habituelle ne change pas.
    expect(listingAccessLine(tribunal, { ...visitor, launchOffer: false })).toBe(FREE_ACCESS_LINE);
    expect(
      listingAccessLine(tribunal, {
        locked: false,
        analysisLocked: false,
        unlocked: false,
        launchOffer: true,
      }),
    ).toBe("Voir le détail");
  });

  it("marque les ventes débloquées d'un compte Découverte", async () => {
    testState.auth.current = { user: { id: "user-a" }, loading: false };
    testState.favoriteQuery.in.mockResolvedValue({ data: [], error: null });
    testState.unlocksOverview.mockResolvedValue({ status: {}, sales: [{ id: "sale-b" }] });

    renderTable([makeSale("sale-a"), makeSale("sale-b")], { analysisLocked: true });

    expect(await screen.findAllByText("Débloquée")).toHaveLength(1);
    const [rowA, rowB] = screen.getAllByRole("row").slice(1);
    expect(rowB.textContent).toContain("Débloquée");
    expect(rowB.textContent).not.toContain(FREE_ACCESS_LINE);
    expect(rowA.textContent).toContain(FREE_ACCESS_LINE);
  });

  it("garde les favoris des cartes : une seule lecture, état par ligne, bascule", async () => {
    testState.auth.current = { user: { id: "user-a" }, loading: false };
    testState.favoriteQuery.in.mockResolvedValue({ data: [{ sale_id: "sale-a" }], error: null });

    renderTable([makeSale("sale-a"), makeSale("sale-b")]);

    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Retirer des favoris" })).toHaveLength(1),
    );
    expect(testState.favoriteQuery.in).toHaveBeenCalledTimes(1);
    expect(testState.favoriteQuery.in).toHaveBeenCalledWith("sale_id", ["sale-a", "sale-b"]);
    const [rowA, rowB] = screen.getAllByRole("row").slice(1);
    expect(
      within(rowA)
        .getByRole("button", { name: "Retirer des favoris" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(within(rowB).getByRole("button", { name: "Ajouter aux favoris" }));
    await waitFor(() =>
      expect(testState.addFavoriteSale).toHaveBeenCalledWith({ data: { saleId: "sale-b" } }),
    );
  });

  it("propose le cœur à un visiteur et l'envoie créer un compte", () => {
    renderTable([makeSale("sale-a")], { locked: true, analysisLocked: true });
    fireEvent.click(screen.getByRole("button", { name: "Ajouter aux favoris" }));
    expect(testState.push).toHaveBeenCalledWith(expect.stringContaining("reason=favori"));
  });

  it("surligne la ligne survolée et prévient la carte au survol et au focus", () => {
    const onHover = vi.fn();
    renderTable([makeSale("sale-a"), makeSale("sale-b")], {
      hoveredSaleId: "sale-b",
      onHover,
    });
    const [rowA, rowB] = screen.getAllByRole("row").slice(1);
    expect(rowB.className).toContain("bg-surface-tint");
    expect(rowA.className).not.toContain("bg-surface-tint");
    fireEvent.mouseEnter(rowA);
    expect(onHover).toHaveBeenLastCalledWith("sale-a");
    fireEvent.mouseLeave(rowA);
    expect(onHover).toHaveBeenLastCalledWith(null);
  });

  it("n'existe qu'au-dessus de lg : la zone est masquée en dessous par le CSS", () => {
    renderTable([makeSale("sale-a")]);
    const region = screen.getByRole("region", { name: "Résultats sous forme de tableau" });
    expect(region.className).toContain("hidden");
    expect(region.className).toContain("lg:block");
  });

  it("montre des lignes de chargement sans lien, puis rien quand il n'y a aucun résultat", () => {
    const { unmount } = renderTable([], { isLoading: true });
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(
      screen.getByRole("table").querySelectorAll('tbody tr[aria-hidden="true"]').length,
    ).toBeGreaterThan(0);
    unmount();

    renderTable([]);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(/Aucune|aucune/)).toBeTruthy();
  });

  it("place l'encart partenaire après le tableau, une seule fois", () => {
    const sales = ["a", "b", "c", "d"].map((id) => makeSale(id));
    renderTable(sales, { sponsoredPlacement: <div data-testid="sponsored">Partenaire</div> });
    const placement = screen.getByTestId("sponsored");
    const table = screen.getByRole("table");
    expect(screen.getAllByTestId("sponsored")).toHaveLength(1);
    expect(
      table.compareDocumentPosition(placement) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(table).queryByTestId("sponsored")).toBeNull();
  });

  it("garde les cartes quand la vue n'est pas « table »", () => {
    renderTable([makeSale("sale-a")], { view: "cards" });
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });
});
