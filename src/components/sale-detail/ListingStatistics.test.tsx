// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { ListingStatistics } from "./ListingStatistics";

const mocks = vi.hoisted(() => ({
  fetchActivity: vi.fn(),
  fetchPrices: vi.fn(),
  getExampleStatistics: vi.fn(),
}));

vi.mock("@/lib/tribunal-listing-statistics-client", () => ({
  fetchTribunalListingStatistics: mocks.fetchActivity,
}));

vi.mock("@/lib/adjudication-price-statistics-client", () => ({
  fetchAdjudicationPriceStatistics: mocks.fetchPrices,
}));

vi.mock("@/lib/example-tribunal-statistics", () => ({
  getExampleTribunalStatistics: mocks.getExampleStatistics,
}));

const metric = (value: number | null, sampleSize = 12) =>
  value == null
    ? { status: "insufficient_data" as const, value: null, sampleSize }
    : { status: "published" as const, value, sampleSize };

const activityResponse = {
  schemaVersion: "tribunal_listing_statistics_v1" as const,
  court: {
    code: "tj-bordeaux",
    name: "Tribunal judiciaire de Bordeaux",
    judicialRegion: "Cour d’appel de Bordeaux",
  },
  period: {
    historyMonths: 3 as const,
    historyStart: "2026-07-01T00:00:00.000Z",
    historyEnd: "2026-10-02T10:00:00.000Z",
    asOf: "2026-10-02T10:00:00.000Z",
  },
  activity: {
    observedAnnouncements: 12,
    publicationDatesKnown: 12,
    discoveryDatesUsed: 12,
    upcomingSales: 8,
    nextSaleAt: "2026-10-15T09:30:00.000Z",
    startingPriceEur: metric(80_000),
    startingPriceToDvfRatio: metric(0.35, 9),
    propertyTypes: [
      { propertyType: "apartment" as const, count: 7, share: 7 / 12 },
      { propertyType: "house" as const, count: 3, share: 3 / 12 },
      { propertyType: "other" as const, count: 2, share: 2 / 12 },
    ],
    visitCoverage: metric(0.75),
    overbidCoverage: metric(0.25),
    overbidsKnown: 3,
    overbidsUnknown: 0,
    publishedToHearingDays: metric(50),
    discoveryToHearingDays: metric(56),
    occupation: {
      knownSales: 10,
      unknownSales: 2,
      distribution: [
        { status: "vacant" as const, count: 4, share: 0.4 },
        { status: "occupied" as const, count: 5, share: 0.5 },
        { status: "rented" as const, count: 1, share: 0.1 },
      ],
    },
    hearingCalendar: [{ date: "2026-10-15", sales: 3 }],
    communes: [{ city: "Bordeaux", count: 8, share: 0.66 }],
    lawyers: [{ name: "Cabinet Durand", count: 4, share: 4 / 12 }],
    upcomingListings: [
      {
        id: "upcoming-sale-1",
        title: "Appartement avec balcon",
        city: "Bordeaux",
        saleAt: "2026-10-15T09:30:00.000Z",
        startingPriceEur: 95_000,
        occupationStatus: "occupied",
        hasVisit: true,
        sourceNames: ["licitor"],
      },
    ],
  },
  meta: {
    generatedAt: "2026-10-02T10:00:00.000Z",
    minSampleSize: 5,
    sources: ["Annonces Immojudis", "Licitor"],
    publicationDateBasis: "source_publication_date_or_first_seen_at" as const,
    deduplication: "canonical_id_source_url_strong_address" as const,
    rawAnnouncements: 12,
    deduplicatedAnnouncements: 12,
    unresolvedStrongAddressDuplicates: 0,
    outcomeGateApplied: false as const,
    limitations: ["Cohorte descriptive locale."],
  },
};

function priceScope(scopeType: "national" | "tribunal", courtCode: string | null) {
  return {
    scopeType,
    label: scopeType === "national" ? "France entière" : "Tribunal judiciaire de Bordeaux",
    courtCode,
    judicialRegion: scopeType === "national" ? null : "Cour d’appel de Bordeaux",
    periodStart: "2026-07-01",
    periodEnd: "2026-10-02",
    sampleSize: 12,
    reliability: "limited" as const,
    metrics: {
      medianHammerToStartingRatio: 1.4,
      aboveStartingRate: 0.7,
      atLeastDoubleRate: 0.2,
      medianHammerPriceEur: 126_000,
      medianStartingPriceEur: 90_000,
    },
    distribution: {
      sampleSize: 12,
      hammerPriceMiddle50Eur: { p25: 90_000, p75: 160_000 },
      ratioMiddle50: { p25: 1.1, p75: 1.8 },
      bidDistribution: [
        { band: "below_starting" as const, count: 1, share: 1 / 12 },
        { band: "at_starting" as const, count: 3, share: 3 / 12 },
        { band: "above_1_below_1_5" as const, count: 4, share: 4 / 12 },
        { band: "from_1_5_below_2" as const, count: 3, share: 3 / 12 },
        { band: "at_least_2" as const, count: 1, share: 1 / 12 },
      ],
    },
  };
}

const prices = {
  national: priceScope("national", null),
  tribunal: priceScope("tribunal", "tj-bordeaux"),
  meta: {
    sourceName: "licitor" as const,
    sourceLabel: "Résultats d’adjudication publiés par Licitor" as const,
    methodologyVersion: "licitor_canonical_price_statistics_v1" as const,
    builtAt: "2026-10-02T10:00:00.000Z",
    reviewedAt: "2026-10-02T10:00:00.000Z",
    experimental: true as const,
    warning:
      "Source tierce non officielle : prix publiés par Licitor, non vérifiés auprès du greffe et non présentés comme définitifs. Agrégats descriptifs uniquement, sans valeur prédictive ni estimation du bien." as const,
  },
};

function renderStatistics(props: Partial<React.ComponentProps<typeof ListingStatistics>> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 5 * 60_000 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ListingStatistics sale={EXAMPLE_SALE} {...props} />
    </QueryClientProvider>,
  );
}

describe("ListingStatistics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchActivity.mockResolvedValue(activityResponse);
    mocks.fetchPrices.mockResolvedValue(prices);
    mocks.getExampleStatistics.mockReturnValue({ activity: activityResponse, prices });
  });

  afterEach(cleanup);

  it("charges le tribunal exact sur trois mois et conserve l’appel prix désactivé sans premium", async () => {
    renderStatistics();

    expect(
      await screen.findByRole("heading", { name: "Tribunal judiciaire de Bordeaux" }),
    ).toBeTruthy();
    expect(mocks.fetchActivity).toHaveBeenCalledWith({
      saleId: EXAMPLE_SALE.id,
      historyMonths: 3,
    });
    expect(mocks.fetchPrices).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Période des annonces"), { target: { value: "12" } });
    await waitFor(() => {
      expect(mocks.fetchActivity).toHaveBeenCalledWith({
        saleId: EXAMPLE_SALE.id,
        historyMonths: 12,
      });
    });
  });

  it("ne sollicite les prix adjugés qu’après activation premium", async () => {
    renderStatistics({ premium: true });

    expect(await screen.findByText("Prix d’adjudication publiés")).toBeTruthy();
    await waitFor(() => expect(mocks.fetchPrices).toHaveBeenCalledWith(EXAMPLE_SALE.id));
  });

  it("utilise la fixture fictive sans appeler les endpoints pour une démo publique", async () => {
    renderStatistics({ publicDemo: true, premium: true });

    expect(await screen.findByText(/Données fictives de démonstration/)).toBeTruthy();
    expect(mocks.getExampleStatistics).toHaveBeenCalledWith(EXAMPLE_SALE, 3);
    expect(mocks.fetchActivity).not.toHaveBeenCalled();
    expect(mocks.fetchPrices).not.toHaveBeenCalled();
  });

  it("n’utilise pas le périmètre national comme remplacement quand le tribunal local ne correspond pas", async () => {
    mocks.fetchPrices.mockResolvedValue({
      ...prices,
      tribunal: priceScope("tribunal", "tj-paris"),
    });
    renderStatistics({ premium: true });

    expect(await screen.findByText("Pas d’échantillon local vérifié")).toBeTruthy();
    expect(screen.getByText("France entière")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Tribunal judiciaire de Bordeaux" })).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Tribunal judiciaire de Bordeaux", level: 4 }),
    ).toBeNull();
    expect(screen.getByText(/ne constitue pas la statistique du tribunal/i)).toBeTruthy();
  });

  it("signale un tribunal non résolu sans inventer de statistiques de ville", async () => {
    const unresolved = new Error("Tribunal non résolu");
    unresolved.name = "TribunalCourtUnresolvedError";
    mocks.fetchActivity.mockRejectedValue(unresolved);
    renderStatistics();

    expect(
      await screen.findByText("Le tribunal exact de cette vente n’est pas encore confirmé"),
    ).toBeTruthy();
    expect(screen.getByText(/Aucune statistique nationale/i)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Réessayer : statistiques du tribunal/i }),
    ).toBeTruthy();
    expect(mocks.fetchPrices).not.toHaveBeenCalled();
  });

  it("préserve un ratio DVF supérieur à 100 % et masque une surenchère inconnue", async () => {
    mocks.fetchActivity.mockResolvedValue({
      ...activityResponse,
      activity: {
        ...activityResponse.activity,
        observedAnnouncements: 6,
        propertyTypes: [{ propertyType: "apartment" as const, count: 4, share: 1 }],
        startingPriceToDvfRatio: metric(1.35, 6),
        overbidCoverage: metric(null, 0),
        overbidsKnown: 0,
        overbidsUnknown: 6,
      },
    });

    renderStatistics();

    expect(await screen.findByText("135 %")).toBeTruthy();
    expect(screen.getByText(/4 annonces avec type renseigné/)).toBeTruthy();
    expect(screen.getByText(/0 connues sur 6 annonces · 6 à confirmer/)).toBeTruthy();
    expect(screen.getByText("Surenchères renseignées").parentElement?.textContent).toContain("—");
  });

  it("n’expose pas de lien cassé pour les ventes fictives de la démo publique", async () => {
    renderStatistics({ publicDemo: true });

    expect(await screen.findByText("Appartement avec balcon")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Appartement avec balcon" })).toBeNull();
  });

  it("déplie les annonces disponibles, permet de réduire et replie sur changement de période", async () => {
    const upcomingListings = Array.from({ length: 100 }, (_, index) => ({
      ...activityResponse.activity.upcomingListings[0]!,
      id: "upcoming-sale-" + String(index + 1),
      title: "Annonce à venir " + String(index + 1),
    }));
    mocks.fetchActivity.mockResolvedValue({
      ...activityResponse,
      activity: {
        ...activityResponse.activity,
        upcomingSales: 125,
        upcomingListings,
      },
    });

    renderStatistics();

    expect(await screen.findByText("Annonce à venir 1")).toBeTruthy();
    expect(screen.queryByText("Annonce à venir 9")).toBeNull();
    expect(screen.getByText(/8 affichées sur 125 annonces recensées/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Voir les 92 autres annonces" }));
    expect(screen.getByText("Annonce à venir 100")).toBeTruthy();
    expect(screen.getByText(/100 affichées sur 125 annonces recensées/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Réduire la liste" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Période des annonces"), { target: { value: "12" } });
    await waitFor(() => {
      expect(mocks.fetchActivity).toHaveBeenCalledWith({
        saleId: EXAMPLE_SALE.id,
        historyMonths: 12,
      });
      expect(screen.getByRole("button", { name: "Voir les 92 autres annonces" })).toBeTruthy();
    });
    expect(screen.queryByText("Annonce à venir 9")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Voir les 92 autres annonces" }));
    fireEvent.click(screen.getByRole("button", { name: "Réduire la liste" }));
    expect(screen.queryByText("Annonce à venir 9")).toBeNull();
  });
});
