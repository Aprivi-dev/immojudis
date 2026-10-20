// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { FavoriteSalesResponse } from "@/lib/favorites";
import type { AiReviewProjectionReadModel } from "@/lib/ai-review-guard";
import { FavoriteSales } from "./FavoriteSales";

const mocks = vi.hoisted(() => ({
  fetchFavoriteSales: vi.fn(),
  fetchSaleChangeEvents: vi.fn(),
  checkoutOpen: vi.fn(),
  fetchSalesAiReviewProjections: vi.fn(),
  fetchFollowedSaleSnapshots: vi.fn(),
  deleteFollowedSaleSnapshot: vi.fn(),
  addFavoriteSale: vi.fn(),
  removeFavoriteSale: vi.fn(),
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "user-1" }, loading: false }),
}));

vi.mock("@/lib/client-api", () => ({
  fetchFavoriteSales: mocks.fetchFavoriteSales,
  fetchSaleChangeEvents: mocks.fetchSaleChangeEvents,
  fetchSalesAiReviewProjections: mocks.fetchSalesAiReviewProjections,
  fetchFollowedSaleSnapshots: mocks.fetchFollowedSaleSnapshots,
  deleteFollowedSaleSnapshot: mocks.deleteFollowedSaleSnapshot,
  addFavoriteSale: mocks.addFavoriteSale,
  removeFavoriteSale: mocks.removeFavoriteSale,
}));
vi.mock("@/hooks/use-analysis-checkout-open", () => ({
  useAnalysisCheckoutOpen: () => mocks.checkoutOpen(),
}));
vi.mock("@/lib/toast", () => ({ toast: mocks.toast }));
vi.mock("@/hooks/use-viewed-sales", () => ({ useViewedSales: () => ({ isViewed: () => false }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

vi.mock("./FavoriteButton", () => ({
  FavoriteButton: ({ saleId }: { saleId: string }) => <button>Retirer {saleId}</button>,
}));

beforeEach(() => {
  mocks.fetchFollowedSaleSnapshots.mockResolvedValue({ snapshots: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function favoritesResponse(): FavoriteSalesResponse {
  return {
    favorites: [
      {
        id: "favorite-1",
        saleId: "sale-1",
        favoritedAt: "2026-09-01T10:00:00.000Z",
        sale: { ...EXAMPLE_SALE, id: "sale-1" },
        personalStatus: null,
        bidCeilingEur: null,
        bidCeilingSavedAt: null,
      },
    ],
    unavailableSaleIds: [],
    summary: {
      total: 1,
      upcomingAudiences: 1,
      nextAudienceAt: "2026-10-15T09:30:00.000Z",
      totalStartingPriceEur: 92_000,
      averageStartingPriceEur: 92_000,
      averageInvestmentScore: 78,
      departments: [{ department: "Gironde", count: 1, totalStartingPriceEur: 92_000 }],
    },
    plan: {
      code: "analyse",
      label: "Analyse",
      feature: "included",
      limit: null,
    },
  } as FavoriteSalesResponse;
}

function blockedProjection(
  fieldKey: AiReviewProjectionReadModel["field_key"],
): AiReviewProjectionReadModel {
  return {
    auction_sale_id: "sale-1",
    field_key: fieldKey,
    review_state: "unresolved",
    citation_status: "not_required",
    is_publishable: false,
    source_name: "AGRASC",
    source_url: "https://agrasc.gouv.fr/vente/1",
  };
}

describe("FavoriteSales", () => {
  it("masks blocked city, price and date values in the client workspace", async () => {
    mocks.fetchFavoriteSales.mockResolvedValue(favoritesResponse());
    mocks.fetchSalesAiReviewProjections.mockResolvedValue({
      projections: [
        blockedProjection("property.city"),
        blockedProjection("sale.starting_price_eur"),
        blockedProjection("sale.sale_date"),
      ],
    });

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <FavoriteSales />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Localisation à préciser")).toBeTruthy();
    expect(screen.getAllByText("À confirmer").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("heading", { level: 3 }).textContent).not.toContain("Bordeaux");
    expect(screen.queryByText(/92\s?000/)).toBeNull();
    expect(screen.queryByText(/15 octobre 2026/)).toBeNull();
    expect(mocks.fetchSalesAiReviewProjections).toHaveBeenCalledWith(["sale-1"]);
  });

  it("réutilise la carte du catalogue et propose Annuler après le retrait d'un favori", async () => {
    mocks.fetchFavoriteSales.mockResolvedValue(favoritesResponse());
    mocks.fetchSalesAiReviewProjections.mockResolvedValue({ projections: [] });
    mocks.removeFavoriteSale.mockResolvedValue({ ok: true, removed: true });
    mocks.addFavoriteSale.mockResolvedValue({ favorite: null, created: true });

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <FavoriteSales />
      </QueryClientProvider>,
    );

    await screen.findByRole("heading", { name: "Appartement · Bordeaux" });
    expect(screen.getByText("Mise à prix")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retirer des favoris" }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    const [message, options] = mocks.toast.mock.calls[0];
    expect(message).toBe("Favori supprimé");
    expect(options.duration).toBe(5000);
    expect(options.action.label).toBe("Annuler");
    options.action.onClick();
    await waitFor(() =>
      expect(mocks.addFavoriteSale).toHaveBeenCalledWith({ data: { saleId: "sale-1" } }),
    );
  });

  it("propose un état vide qui renvoie vers le catalogue", async () => {
    mocks.fetchFavoriteSales.mockResolvedValue({
      ...favoritesResponse(),
      favorites: [],
    });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <FavoriteSales />
      </QueryClientProvider>,
    );
    await screen.findByText("Aucun favori pour le moment");
    expect(screen.getByRole("link", { name: "Voir les ventes" }).getAttribute("href")).toBe(
      "/sales",
    );
  });
});

describe("FavoriteSales : Mon dossier (point 68)", () => {
  function renderPage() {
    return render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <FavoriteSales />
      </QueryClientProvider>,
    );
  }

  it("affiche le statut et le plafond enregistrés sous la carte du favori", async () => {
    const response = favoritesResponse();
    response.favorites[0] = {
      ...response.favorites[0],
      personalStatus: "bidding",
      bidCeilingEur: 185_000,
      bidCeilingSavedAt: "2026-10-10T08:00:00.000Z",
    };
    mocks.fetchFavoriteSales.mockResolvedValue(response);
    mocks.fetchSalesAiReviewProjections.mockResolvedValue({ projections: [] });
    mocks.fetchSaleChangeEvents.mockResolvedValue({ events: [] });
    renderPage();

    await screen.findByRole("heading", { name: "Appartement · Bordeaux" });
    expect(screen.getByText("Prêt à enchérir")).toBeTruthy();
    expect(screen.getByText(/185\s000\s€/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Modifier sur la fiche" }).getAttribute("href")).toBe(
      "/sales/sale-1",
    );
  });

  it("affiche une valeur absente comme absente, jamais comme un statut ou un montant", async () => {
    mocks.fetchFavoriteSales.mockResolvedValue(favoritesResponse());
    mocks.fetchSalesAiReviewProjections.mockResolvedValue({ projections: [] });
    mocks.fetchSaleChangeEvents.mockResolvedValue({ events: [] });
    renderPage();

    await screen.findByRole("heading", { name: "Appartement · Bordeaux" });
    expect(screen.getByText("aucun")).toBeTruthy();
    expect(screen.getByText("aucun enregistré")).toBeTruthy();
  });
});

describe("FavoriteSales : changements des ventes suivies", () => {
  function renderPage() {
    return render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <FavoriteSales />
      </QueryClientProvider>,
    );
  }

  function changeEvent(overrides: Record<string, unknown> = {}) {
    return {
      id: "event-1",
      saleId: "sale-1",
      watchKind: "favorite",
      watchId: "watch-1",
      eventKind: "price_changed",
      severity: "important",
      fingerprint: "price_changed:startingPriceEur:120000:100000",
      summaryLabel: "Mise à prix abaissée",
      changeSummary: { field: "startingPriceEur", previousValue: 120000, currentValue: 100000 },
      detectedAt: "2026-10-14T06:45:00.000Z",
      readAt: null,
      dismissedAt: null,
      ...overrides,
    };
  }

  function setup(events: unknown[] = []) {
    // Only the clock is faked: the changes of the last 30 days are relative to "now".
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-15T10:00:00Z") });
    mocks.checkoutOpen.mockReturnValue(true);
    mocks.fetchFavoriteSales.mockResolvedValue(favoritesResponse());
    mocks.fetchSalesAiReviewProjections.mockResolvedValue({ projections: [] });
    mocks.fetchSaleChangeEvents.mockResolvedValue({ events });
  }

  it("liste les changements récents des ventes suivies, avec leur date de détection", async () => {
    setup([
      changeEvent(),
      // Même changement enregistré pour une alerte : listé une seule fois.
      changeEvent({ id: "event-2", watchKind: "alert_match", watchId: "watch-2" }),
      changeEvent({
        id: "event-3",
        eventKind: "status_changed",
        fingerprint: "status_changed:status:upcoming:postponed",
        changeSummary: { field: "status", previousValue: "upcoming", currentValue: "postponed" },
        detectedAt: "2026-10-12T06:45:00.000Z",
      }),
      // Une vente qui n'est pas dans les favoris, et un score : ni l'un ni l'autre ne s'affichent.
      changeEvent({ id: "event-4", saleId: "sale-9", fingerprint: "autre" }),
      changeEvent({ id: "event-5", eventKind: "score_changed", fingerprint: "score" }),
    ]);

    renderPage();

    expect(await screen.findByRole("heading", { name: "Changements récents" })).toBeTruthy();
    expect(await screen.findByText("Mise à prix abaissée")).toBeTruthy();
    expect(screen.getAllByText("Mise à prix abaissée")).toHaveLength(1);
    expect(screen.getByText(/120\s000\s€ → 100\s000\s€/)).toBeTruthy();
    expect(screen.getByText("Détecté le 14 octobre 2026")).toBeTruthy();
    expect(screen.getByText("Vente reportée")).toBeTruthy();
    expect(screen.getByText("Nouvelle date à confirmer.")).toBeTruthy();
    expect(screen.getByText("Détecté le 12 octobre 2026")).toBeTruthy();
    expect(screen.queryByText(/Score/)).toBeNull();
    expect(
      screen.getAllByRole("link", { name: "Appartement à Bordeaux" })[0].getAttribute("href"),
    ).toBe("/sales/sale-1");
    expect(
      screen.getByText(/Vérifiez toute date ou tout montant auprès de l’avocat poursuivant/),
    ).toBeTruthy();
    expect(mocks.fetchSaleChangeEvents).toHaveBeenCalledTimes(1);
  });

  it("indique l'absence de changement", async () => {
    setup([]);
    renderPage();
    expect(await screen.findByText("Aucun changement détecté")).toBeTruthy();
    const body = screen.getByText(/Aucun changement détecté sur vos favoris ces 30 derniers jours/);
    expect(body.textContent).toContain("dans les annonces que nous collectons");
    expect(body.textContent).toContain("n’est pas une garantie");
    expect(body.textContent).toContain("auprès de l’avocat poursuivant avant de vous déplacer");
    expect(document.body.textContent).not.toContain("dès qu’il est détecté");
  });

  it("annonce le chargement", async () => {
    setup();
    mocks.fetchSaleChangeEvents.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(await screen.findByText("Chargement des changements de vos ventes…")).toBeTruthy();
  });

  it("propose de réessayer quand les changements ne se chargent pas", async () => {
    setup();
    mocks.fetchSaleChangeEvents
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { status: 500 }))
      .mockResolvedValueOnce({ events: [changeEvent()] });
    renderPage();

    expect(
      await screen.findByText("Impossible de charger les changements pour le moment."),
    ).toBeTruthy();
    // Les favoris restent affichés malgré l'erreur.
    expect(screen.getByRole("heading", { name: "Appartement · Bordeaux" })).toBeTruthy();
    const retry = screen.getAllByRole("button", { name: "Réessayer" });
    fireEvent.click(retry[retry.length - 1]);

    expect(await screen.findByText("Mise à prix abaissée")).toBeTruthy();
    expect(mocks.fetchSaleChangeEvents).toHaveBeenCalledTimes(2);
  });

  it("masque les montants et les dates retenus par la vérification de la fiche", async () => {
    setup([changeEvent()]);
    mocks.fetchSalesAiReviewProjections.mockResolvedValue({
      projections: [blockedProjection("sale.starting_price_eur")],
    });
    renderPage();

    expect(await screen.findByText("Montants à confirmer.")).toBeTruthy();
    expect(screen.queryByText(/120\s000/)).toBeNull();
  });

  it("n'affiche qu'un aperçu verrouillé en offre Découverte et n'appelle pas l'API", async () => {
    setup([changeEvent()]);
    mocks.fetchFavoriteSales.mockResolvedValue({
      ...favoritesResponse(),
      plan: { code: "decouverte", label: "Découverte", feature: "limited", limit: 3 },
    });
    renderPage();

    expect(await screen.findByText("Suivez les changements de vos ventes")).toBeTruthy();
    expect(screen.getByText(/Avec l’offre Analyse/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Découvrir l’offre Analyse" }).getAttribute("href"),
    ).toBe("/offres");
    expect(screen.queryByText("Changements récents")).toBeNull();
    expect(screen.queryByText("Mise à prix abaissée")).toBeNull();
    expect(mocks.fetchSaleChangeEvents).not.toHaveBeenCalled();
  });

  it("affiche les favoris d'abord, puis une ligne compacte pour le suivi non inclus", async () => {
    setup();
    mocks.fetchFavoriteSales.mockResolvedValue({
      ...favoritesResponse(),
      plan: { code: "decouverte", label: "Découverte", feature: "limited", limit: 3 },
    });
    renderPage();

    const line = await screen.findByRole("region", {
      name: "Suivez les changements de vos ventes",
    });
    const card = screen.getByRole("heading", { name: "Appartement · Bordeaux" });
    // La carte du favori précède la ligne d'offre dans la page.
    expect(card.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Une ligne : ni aperçu flouté, ni libellés de substitution.
    expect(line.querySelector(".blur-\\[5px\\]")).toBeNull();
    expect(screen.queryByText("Date modifiée")).toBeNull();
    expect(line.querySelectorAll("a")).toHaveLength(1);
  });

  it("affiche aussi les favoris avant les changements récents d'un compte Analyse", async () => {
    setup([changeEvent()]);
    renderPage();

    const changes = await screen.findByRole("heading", { name: "Changements récents" });
    const card = screen.getByRole("heading", { name: "Appartement · Bordeaux" });
    expect(card.compareDocumentPosition(changes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("ne promet ni essai ni souscription quand l'offre Analyse n'est pas ouverte", async () => {
    setup();
    mocks.checkoutOpen.mockReturnValue(false);
    mocks.fetchFavoriteSales.mockResolvedValue({
      ...favoritesResponse(),
      plan: { code: "decouverte", label: "Découverte", feature: "limited", limit: 3 },
    });
    renderPage();

    expect(await screen.findByText("Suivez les changements de vos ventes")).toBeTruthy();
    expect(
      screen.getByText("L’offre Analyse n’est pas encore ouverte à la souscription."),
    ).toBeTruthy();
    expect(screen.queryByText(/essai/i)).toBeNull();
  });

  it("revient à l'aperçu verrouillé quand l'API refuse le droit", async () => {
    setup();
    mocks.fetchSaleChangeEvents.mockRejectedValue(
      Object.assign(new Error("Réservé"), { status: 403 }),
    );
    renderPage();

    expect(await screen.findByText("Suivez les changements de vos ventes")).toBeTruthy();
    expect(screen.queryByText("Impossible de charger les changements pour le moment.")).toBeNull();
    expect(mocks.fetchSaleChangeEvents).toHaveBeenCalledTimes(1);
  });

  it("place « Ventes passées » au-dessus de « Annonces retirées du catalogue »", async () => {
    setup();
    mocks.fetchFavoriteSales.mockResolvedValue({
      ...favoritesResponse(),
      unavailableSaleIds: ["gone-1"],
    });
    mocks.fetchFollowedSaleSnapshots.mockResolvedValue({
      snapshots: [
        {
          id: "snap-1",
          saleId: "sale-9",
          capturedAt: "2026-10-14T12:05:00.000Z",
          expiresAt: "2027-04-14T12:05:00.000Z",
          title: "Maison de ville",
          city: "Bordeaux",
          department: "33",
          postalCode: "33000",
          propertyType: "house",
          tribunalName: null,
          startingPriceEur: 100_000,
          saleDate: "2026-10-14T12:00:00.000Z",
          lawyerName: null,
          sourceName: null,
          result: { status: "unknown", priceEur: null, priceSource: null, priceWithheld: false },
          personalStatus: null,
          bidCeilingEur: null,
          surenchere: { kind: "not_applicable" },
        },
      ],
    });
    renderPage();

    const past = await screen.findByRole("heading", { name: "Ventes passées" });
    const removed = await screen.findByRole("heading", {
      name: "Annonces retirées du catalogue",
    });
    expect(past.compareDocumentPosition(removed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("n'affiche rien quand il n'y a aucun favori", async () => {
    setup();
    mocks.fetchFavoriteSales.mockResolvedValue({ ...favoritesResponse(), favorites: [] });
    renderPage();

    await screen.findByText("Aucun favori pour le moment");
    expect(screen.queryByText("Changements récents")).toBeNull();
    expect(mocks.fetchSaleChangeEvents).not.toHaveBeenCalled();
  });
});
