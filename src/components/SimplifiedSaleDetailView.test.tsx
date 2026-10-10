// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { EXAMPLE_SALE_RECORDS } from "@/lib/example-sale";
import type { AuctionSale } from "@/lib/types";
import type { MarketEstimate } from "@/lib/market.server";
import { AI_REVIEW_FIELD_KEYS, type AiReviewProjectionReadModel } from "@/lib/ai-review-guard";
import { AnalysisSaleDetailView, FreeSaleDetailView } from "./SimplifiedSaleDetailView";

const mocks = vi.hoisted(() => ({
  fetchMarket: vi.fn(),
  fetchAiReviewProjections: vi.fn(),
  fetchFactReliabilities: vi.fn(),
  fetchUrbanism: vi.fn(),
  forecast: vi.fn(),
  authUser: null as { id: string } | null,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.authUser, loading: false }),
}));
vi.mock("@/lib/client-api", () => ({
  fetchPrecomputedMarketEstimate: mocks.fetchMarket,
  fetchSaleAiReviewProjections: mocks.fetchAiReviewProjections,
  fetchSaleFactReliabilities: mocks.fetchFactReliabilities,
  fetchSaleUrbanismeCadastre: mocks.fetchUrbanism,
}));
vi.mock("@/components/FavoriteButton", () => ({
  FavoriteButton: () => <button>Suivre cette vente</button>,
}));
vi.mock("@/components/MapboxPreviewButton", () => ({
  MapboxPreviewButton: ({ label }: { label: string }) => <button>{label}</button>,
}));
vi.mock("@/components/MapThumbnail", () => ({ MapThumbnail: () => <div>Carte</div> }));
vi.mock("./sale-detail/CadastralNeighborhoodMap", () => ({
  CadastralNeighborhoodMap: ({ lat, lng }: { lat: number; lng: number }) => (
    <div data-testid="cadastral-map" data-lat={lat} data-lng={lng}>
      Plan cadastral
    </div>
  ),
}));
vi.mock("@/components/SaleVisual", () => ({ SaleVisual: () => <div>Visuel indisponible</div> }));
vi.mock("@/components/BillingActions", () => ({
  BillingActions: () => <button>Découvrir l’offre Analyse</button>,
}));
vi.mock("@/components/DocumentsList", () => ({ DocumentsList: () => <p>Pièces du dossier</p> }));
vi.mock("@/components/LawyerReferralButton", () => ({
  LawyerReferralButton: () => <button>Contacter un avocat</button>,
}));
vi.mock("@/hooks/use-outcome-graph-forecast", () => ({
  useOutcomeGraphForecast: (id: string, enabled: boolean) => mocks.forecast(id, enabled) ?? {},
}));
vi.mock("next/dynamic", () => ({
  default: () =>
    function LazyDetail({
      images,
      onClose,
      saleId,
      sale,
      marketEstimateOverride,
      forecastQuery,
      premium,
      propertyTypeVerified,
    }: {
      images?: unknown[];
      onClose?: () => void;
      saleId?: string;
      sale?: AuctionSale;
      marketEstimateOverride?: unknown;
      forecastQuery?: unknown;
      premium?: boolean;
      propertyTypeVerified?: boolean;
    }) {
      if (forecastQuery) return <section>Prévision de l’audience chargée</section>;
      if (sale && marketEstimateOverride === undefined) {
        return (
          <section
            id="stats-overview"
            data-sale-id={sale.id}
            data-court-code={sale.tribunal_code}
            data-premium={premium ? "true" : "false"}
            data-property-type-verified={propertyTypeVerified ? "true" : "false"}
          >
            Statistiques du tribunal
          </section>
        );
      }
      if (saleId) return <button data-sale-id={saleId}>Export PDF</button>;
      return images ? (
        <div role="dialog" aria-label="Galerie photos">
          <button onClick={onClose}>Fermer les photos</button>
        </div>
      ) : (
        <div>Simulateur d’enchère plafond chargé</div>
      );
    },
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  mocks.authUser = null;
  window.history.replaceState(null, "", "/");
});

function renderDetail(
  access: "analysis" | "discovery",
  sale = EXAMPLE_SALE_RECORDS.bordeaux.sale,
  publicDemo = true,
  adjudicationStatisticsEnabled = false,
  marketEstimate: MarketEstimate = EXAMPLE_SALE_RECORDS.bordeaux.marketEstimate,
  aiReviewProjections: { projections: AiReviewProjectionReadModel[] } = { projections: [] },
) {
  mocks.fetchAiReviewProjections.mockResolvedValue(aiReviewProjections);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      {access === "analysis" ? (
        <AnalysisSaleDetailView
          sale={sale}
          marketEstimateOverride={marketEstimate}
          publicDemo={publicDemo}
          adjudicationStatisticsEnabled={adjudicationStatisticsEnabled}
        />
      ) : (
        <FreeSaleDetailView sale={sale} />
      )}
    </QueryClientProvider>,
  );
}

function selectTab(label: string) {
  fireEvent.click(screen.getByRole("tab", { name: label }));
}

function expectActivePanel(container: HTMLElement, tab: string): HTMLElement {
  const panels = [...container.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
  expect(panels).toHaveLength(1);
  expect(panels[0].id).toBe(`sale-detail-panel-${tab}`);
  expect(panels[0].getAttribute("aria-labelledby")).toBe(`sale-detail-tab-${tab}`);
  return panels[0];
}

describe("integrated listing", () => {
  it("mounts one panel at a time and supports keyboard tab navigation", () => {
    const { container } = renderDetail("analysis");

    expect(screen.getAllByRole("tab")).toHaveLength(6);
    expect(screen.getByRole("tab", { name: "Aperçu" }).getAttribute("aria-selected")).toBe("true");
    expectActivePanel(container, "apercu");

    selectTab("Estimation");
    expect(screen.getByRole("tab", { name: "Estimation" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expectActivePanel(container, "estimation");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Estimation" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Statistiques" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expectActivePanel(container, "statistiques");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Statistiques" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Travaux" }).getAttribute("aria-selected")).toBe("true");
    expectActivePanel(container, "travaux");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Travaux" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "Démarches" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expectActivePanel(container, "demarches");
  });

  it("maps legacy deep links to the corresponding compact panel", () => {
    window.history.replaceState(null, "", "#works");
    const { container } = renderDetail("analysis");

    expect(screen.getByRole("tab", { name: "Travaux" }).getAttribute("aria-selected")).toBe("true");
    expectActivePanel(container, "travaux");

    window.history.pushState(null, "", "#market");
    fireEvent(window, new Event("hashchange"));
    expect(screen.getByRole("tab", { name: "Estimation" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expectActivePanel(container, "estimation");
  });

  it("defers tribunal forecast loading until its disclosure opens", () => {
    const sale = EXAMPLE_SALE_RECORDS.bordeaux.sale;
    renderDetail("analysis", sale, false);
    selectTab("Estimation");

    expect(mocks.forecast).toHaveBeenLastCalledWith(sale.id, false);
    const summary = screen.getByText("Perspective d’adjudication");
    const details = summary.closest("details");
    expect(details?.open).toBe(false);

    fireEvent.click(summary);
    expect(details?.open).toBe(true);
    expect(mocks.forecast).toHaveBeenLastCalledWith(sale.id, true);

    fireEvent.click(summary);
    fireEvent.click(summary);
    expect(details?.open).toBe(true);
    expect(mocks.forecast).toHaveBeenLastCalledWith(sale.id, true);
  });

  it.each([
    { anchor: "works", tab: "Travaux", panel: "travaux" },
    { anchor: "financing", tab: "Financement", panel: "financement" },
  ])("selects and scrolls to the lazy $anchor section", ({ anchor, tab, panel }) => {
    window.history.replaceState(null, "", `#${anchor}`);
    const scrollIntoView = vi.fn();
    const prototype = HTMLElement.prototype as HTMLElement & {
      scrollIntoView: typeof scrollIntoView;
    };
    const previousScrollIntoView = prototype.scrollIntoView;
    prototype.scrollIntoView = scrollIntoView;

    try {
      const { container } = renderDetail("analysis");

      expect(screen.getByRole("tab", { name: tab }).getAttribute("aria-selected")).toBe("true");
      expectActivePanel(container, panel);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    } finally {
      prototype.scrollIntoView = previousScrollIntoView;
    }
  });

  it.each([
    {
      anchor: "market",
      tab: "estimation",
      target: "market",
      summary: "Voir les références de marché",
    },
    {
      anchor: "budget",
      tab: "estimation",
      target: "budget",
      summary: "Frais et hypothèses",
      sale: {
        ...EXAMPLE_SALE_RECORDS.bordeaux.sale,
        sale_venue_type: "notary",
        sale_procedure: null,
        source_blocks: null,
      } as AuctionSale,
    },
    { anchor: "budget-analysis", tab: "estimation" },
    {
      anchor: "participation",
      tab: "demarches",
      target: "participation",
      summary: "Voir toutes les conditions de la vente",
    },
    {
      anchor: "professional-pilot",
      tab: "demarches",
      target: "professional-pilot",
      summary: "Préparer le dossier de travail",
      publicDemo: false,
    },
    {
      anchor: "tribunal-perspective",
      tab: "estimation",
      target: "tribunal-perspective",
      summary: "Perspective d’adjudication",
      publicDemo: false,
    },
    {
      anchor: "calculation",
      tab: "estimation",
      target: "calculation",
      summary: "Ajuster les hypothèses",
      publicDemo: false,
    },
    {
      anchor: "why-this-ceiling",
      tab: "estimation",
      target: "why-this-ceiling",
      summary: "Comprendre le calcul du plafond",
      publicDemo: false,
    },
  ] as const)(
    "routes #%s to the expected panel and opens its detail when the target exists",
    (expectation) => {
      window.history.replaceState(null, "", `#${expectation.anchor}`);
      const { container } = renderDetail(
        "analysis",
        expectation.sale,
        expectation.publicDemo ?? false,
      );

      expect(
        screen
          .getByRole("tab", {
            name:
              expectation.tab === "estimation"
                ? "Estimation"
                : expectation.tab === "demarches"
                  ? "Démarches"
                  : "Aperçu",
          })
          .getAttribute("aria-selected"),
      ).toBe("true");
      expectActivePanel(container, expectation.tab);

      const target = expectation.target ? container.querySelector(`#${expectation.target}`) : null;
      if (!expectation.target) {
        expect(target).toBeNull();
        return;
      }

      expect(target).not.toBeNull();
      const details = screen.getByText(expectation.summary).closest("details");
      expect(details).not.toBeNull();
      expect(details?.contains(target)).toBe(true);
      expect(details?.open).toBe(true);
    },
  );

  it("uses a client-side initial hash to open the requested estimation detail", () => {
    window.history.replaceState(null, "", "#calculation");
    const { container } = renderDetail("analysis", EXAMPLE_SALE_RECORDS.bordeaux.sale, false);

    expect(screen.getByRole("tab", { name: "Estimation" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    const calculation = container.querySelector("#calculation") as HTMLDetailsElement | null;
    expect(calculation).not.toBeNull();
    expect(calculation?.open).toBe(true);
  });

  it("opens the documents disclosure when #documents targets Démarches", () => {
    window.history.replaceState(null, "", "#documents");
    const { container } = renderDetail("analysis");

    expect(screen.getByRole("tab", { name: "Démarches" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expectActivePanel(container, "demarches");

    const documents = container.querySelector<HTMLElement>("#documents");
    expect(documents).not.toBeNull();
    const details = documents?.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(true);
  });

  it("opens the budget detail for #budget-analysis when a tribunal valuation conflicts", () => {
    const conflictingSale: AuctionSale = {
      ...EXAMPLE_SALE_RECORDS.bordeaux.sale,
      property_type: "land",
      source_blocks: {
        ...(EXAMPLE_SALE_RECORDS.bordeaux.sale.source_blocks ?? {}),
        titre_detail: "Appartement T5 avec terrasse et garage",
      },
    };
    window.history.replaceState(null, "", "#budget-analysis");
    const { container } = renderDetail("analysis", conflictingSale, false);

    expect(screen.getByRole("tab", { name: "Estimation" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expectActivePanel(container, "estimation");

    const budget = container.querySelector<HTMLElement>("#budget");
    expect(budget).not.toBeNull();
    const details = budget?.closest("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(true);
    expect(screen.queryByText("Ajuster les hypothèses")).toBeNull();
    expect(screen.queryByText("Simulateur d’enchère plafond chargé")).toBeNull();
  });

  it("resets to Aperçu when navigating to another same-type sale without a hash", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <AnalysisSaleDetailView
          sale={EXAMPLE_SALE_RECORDS.bordeaux.sale}
          marketEstimateOverride={EXAMPLE_SALE_RECORDS.bordeaux.marketEstimate}
          publicDemo
        />
      </QueryClientProvider>,
    );

    selectTab("Estimation");
    expectActivePanel(view.container, "estimation");
    window.history.replaceState(null, "", "/");

    view.rerender(
      <QueryClientProvider client={client}>
        <AnalysisSaleDetailView
          sale={EXAMPLE_SALE_RECORDS.nantes.sale}
          marketEstimateOverride={EXAMPLE_SALE_RECORDS.nantes.marketEstimate}
          publicDemo
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("tab", { name: "Aperçu" }).getAttribute("aria-selected")).toBe("true");
    expectActivePanel(view.container, "apercu");
  });

  it("loads a cadastral candidate only for an authenticated analysis", async () => {
    mocks.authUser = { id: "user-1" };
    mocks.fetchUrbanism.mockResolvedValue({
      cadastralParcels: [
        {
          parcelKey: "33063-AB-123",
          parcelId: "33063000AB0123",
          codeInsee: "33063",
          department: "33",
          city: "Bordeaux",
          section: "AB",
          parcelNumber: "123",
          surfaceM2: 480,
          centroidLat: 44.8378,
          centroidLng: -0.5792,
          matchKind: "point_intersection",
          confidence: 0.88,
          sourceApi: "API Carto Cadastre",
        },
      ],
      urbanPlanningSignals: [],
    });

    const live = renderDetail("analysis", EXAMPLE_SALE_RECORDS.bordeaux.sale, false);
    expect(await screen.findByText("Section AB n° 123")).toBeTruthy();
    expect(screen.getByText("Référence cadastrale à recouper")).toBeTruthy();
    expect(screen.getByText("Point géocodé · à recouper")).toBeTruthy();
    expect(mocks.fetchUrbanism).toHaveBeenCalledWith(EXAMPLE_SALE_RECORDS.bordeaux.sale.id);
    live.unmount();

    mocks.fetchUrbanism.mockClear();
    renderDetail("analysis", EXAMPLE_SALE_RECORDS.bordeaux.sale, true);
    expect(mocks.fetchUrbanism).not.toHaveBeenCalled();
  });

  it("loads the authorized AI review projection and masks blocked listing fields", async () => {
    mocks.authUser = { id: "user-1" };
    mocks.fetchFactReliabilities.mockResolvedValue({ facts: {}, source: "legacy" });

    renderDetail("analysis", EXAMPLE_SALE_RECORDS.bordeaux.sale, false, false, undefined, {
      projections: [
        {
          auction_sale_id: EXAMPLE_SALE_RECORDS.bordeaux.sale.id,
          field_key: "property.property_type",
          review_state: "unverified",
          citation_status: "unverified",
          is_publishable: false,
          source_name: "AGRASC",
          source_url: "https://example.test/source/1",
        },
      ],
    });

    expect(await screen.findAllByText("Type de bien à confirmer")).not.toHaveLength(0);
    expect(mocks.fetchAiReviewProjections).toHaveBeenCalledWith(
      EXAMPLE_SALE_RECORDS.bordeaux.sale.id,
    );
  });

  it("does not reuse a blocked city in the property title or photo alt text", () => {
    mocks.authUser = { id: "user-1" };
    const projections: AiReviewProjectionReadModel[] = AI_REVIEW_FIELD_KEYS.map((fieldKey) => ({
      auction_sale_id: EXAMPLE_SALE_RECORDS.bordeaux.sale.id,
      field_key: fieldKey,
      review_state: fieldKey === "property.city" ? "unresolved" : "resolved",
      citation_status: fieldKey === "property.city" ? "not_required" : "verified",
      is_publishable: fieldKey !== "property.city",
      source_name: "AGRASC",
      source_url: "https://example.test/source/1",
    }));

    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <AnalysisSaleDetailView
          sale={EXAMPLE_SALE_RECORDS.bordeaux.sale}
          marketEstimateOverride={EXAMPLE_SALE_RECORDS.bordeaux.marketEstimate}
          publicDemo={false}
          aiReviewProjections={projections}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      "Localisation à confirmer",
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).not.toContain("Bordeaux");
    const map = screen.getByTestId("cadastral-map");
    expect(map.getAttribute("data-lat")).toBe(String(EXAMPLE_SALE_RECORDS.bordeaux.sale.latitude));
    expect(map.getAttribute("data-lng")).toBe(String(EXAMPLE_SALE_RECORDS.bordeaux.sale.longitude));
    expect(map.closest("details")).toBeNull();
    expect(mocks.fetchUrbanism).not.toHaveBeenCalled();
    expect(
      [...container.querySelectorAll<HTMLImageElement>("img")].every(
        (image) => !image.alt.includes("Bordeaux"),
      ),
    ).toBe(true);
  });

  it("does not reinsert source-block visit dates when the sale date review is blocked", () => {
    const sale = {
      ...EXAMPLE_SALE_RECORDS.bordeaux.sale,
      visit_dates: null,
      source_description: "Visite le 2 octobre 2026 à 14 heures.",
      description: "Visite le 2 octobre 2026 à 14 heures.",
      source_blocks: {
        ...(EXAMPLE_SALE_RECORDS.bordeaux.sale.source_blocks ?? {}),
        visites: "2026-10-02 à 14:00",
      },
    } as AuctionSale;
    const projections: AiReviewProjectionReadModel[] = AI_REVIEW_FIELD_KEYS.map((fieldKey) => ({
      auction_sale_id: sale.id,
      field_key: fieldKey,
      review_state: fieldKey === "sale.sale_date" ? "unresolved" : "resolved",
      citation_status: fieldKey === "sale.sale_date" ? "not_required" : "verified",
      is_publishable: fieldKey !== "sale.sale_date",
      source_name: "AGRASC",
      source_url: "https://example.test/source/1",
    }));

    render(
      <QueryClientProvider client={new QueryClient()}>
        <AnalysisSaleDetailView
          sale={sale}
          marketEstimateOverride={EXAMPLE_SALE_RECORDS.bordeaux.marketEstimate}
          publicDemo={false}
          aiReviewProjections={projections}
        />
      </QueryClientProvider>,
    );
    selectTab("Démarches");

    expect(screen.queryByText(/2 octobre 2026/)).toBeNull();
    expect(screen.getByText("Dates de visite non renseignées")).toBeTruthy();
  });

  it("keeps address-history caveats inside the Estimation detail", () => {
    const estimate = {
      ...EXAMPLE_SALE_RECORDS.bordeaux.marketEstimate,
      comparableMode: "address_history" as const,
      sampleSize: 0,
      recentTransactions: [],
    };
    const { container } = renderDetail(
      "analysis",
      EXAMPLE_SALE_RECORDS.bordeaux.sale,
      true,
      false,
      estimate,
    );
    selectTab("Estimation");

    const summary = screen.getByText("Voir les références de marché");
    const disclosure = summary.closest("details");
    expect(disclosure).not.toBeNull();
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.contains(container.querySelector("#market"))).toBe(true);

    fireEvent.click(summary);
    const market = container.querySelector("#market")!;
    expect(market.textContent).toContain("1 vente à cette adresse");
    expect(market.textContent).toContain("Historique des ventes à cette adresse");
    expect(market.textContent).toContain("lots différents");
    expect(market.textContent).toContain("Transactions DVF");
  });

  it("keeps aggregate market scope explicit inside the Estimation detail", () => {
    const estimate = {
      ...EXAMPLE_SALE_RECORDS.bordeaux.marketEstimate,
      comparableMode: "geographic_aggregate" as const,
      geographyLevel: "department" as const,
      recentTransactions: [],
    };
    const { container } = renderDetail(
      "analysis",
      EXAMPLE_SALE_RECORDS.bordeaux.sale,
      true,
      false,
      estimate,
    );
    selectTab("Estimation");
    fireEvent.click(screen.getByText("Voir les références de marché"));

    const market = container.querySelector("#market")!;
    expect(market.textContent).toContain("12 ventes de référence");
    expect(market.textContent).toContain("Échelle du département");
    expect(market.textContent).not.toContain("Rayon de recherche");
    expect(market.querySelector('[aria-label="Comparables de marché"]')).toBeNull();
  });

  it("puts the date, venue and contact in Démarches", () => {
    const { container } = renderDetail("analysis");
    selectTab("Démarches");

    const practical = container.querySelector("#rendez-vous")!;
    expect(practical.textContent).toContain("Tribunal judiciaire de Bordeaux");
    expect(practical.textContent).toContain("Me Camille Durand");
    expect(practical.textContent).toMatch(/15 octobre 2026/);
    expect(practical.textContent).toContain("Visites");
  });

  it("exposes report export only in a real analysis Démarches panel", () => {
    const sale = EXAMPLE_SALE_RECORDS.bordeaux.sale;
    const live = renderDetail("analysis", sale, false);
    selectTab("Démarches");
    expect(screen.getByRole("button", { name: "Export PDF" }).getAttribute("data-sale-id")).toBe(
      sale.id,
    );
    live.unmount();

    window.history.replaceState(null, "", "/");
    renderDetail("analysis", sale, true);
    selectTab("Démarches");
    expect(screen.queryByRole("button", { name: "Export PDF" })).toBeNull();
  });

  it("opens the advanced simulator from the Estimation action", () => {
    const { container } = renderDetail("analysis", EXAMPLE_SALE_RECORDS.bordeaux.sale, false);
    selectTab("Estimation");

    const calculation = container.querySelector("#calculation") as HTMLDetailsElement;
    expect(calculation.open).toBe(false);
    fireEvent.click(screen.getByRole("link", { name: "Ajuster mes hypothèses" }));
    expect(calculation.open).toBe(true);
    expect(screen.getByText("Simulateur d’enchère plafond chargé")).toBeTruthy();
  });

  it("keeps the photo gallery action functional in the Aperçu panel", () => {
    renderDetail("analysis");
    fireEvent.click(screen.getByRole("button", { name: "Ouvrir la photo 1 sur 4" }));
    expect(screen.getByRole("dialog", { name: "Galerie photos" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fermer les photos" }));
    expect(screen.queryByRole("dialog", { name: "Galerie photos" })).toBeNull();
  });

  it("keeps protected market and risk evidence out of discovery access", () => {
    const discovery = renderDetail("discovery");
    expect(screen.queryByText("Marché local")).toBeNull();
    expect(screen.queryByText("Voir les sources et actions à confirmer")).toBeNull();
    expect(mocks.fetchMarket).not.toHaveBeenCalled();
    discovery.unmount();

    window.history.replaceState(null, "", "/");
    renderDetail("analysis");
    expect(screen.getByText("Voir les sources et actions à confirmer")).toBeTruthy();
    selectTab("Estimation");
    expect(screen.getByText("Voir les références de marché")).toBeTruthy();
  });

  it("shows Premium previews without loading analyses or mounting the works and statistics tools", () => {
    mocks.authUser = { id: "free-account" };
    renderDetail("discovery");
    selectTab("Estimation");
    expect(
      screen.getByRole("heading", {
        name: "La valeur du bien et votre enchère plafond avec l’offre Analyse",
      }),
    ).toBeTruthy();
    selectTab("Travaux");
    expect(
      screen.getByRole("heading", { name: "Estimez vos travaux avec l’offre Analyse" }),
    ).toBeTruthy();
    expect(screen.queryByText("Simulateur d’enchère plafond chargé")).toBeNull();
    selectTab("Statistiques");
    expect(
      screen.getByRole("heading", { name: "Les statistiques du tribunal avec l’offre Analyse" }),
    ).toBeTruthy();
    expect(screen.queryByText("Statistiques du tribunal")).toBeNull();
    expect(mocks.fetchMarket).not.toHaveBeenCalled();
    expect(mocks.fetchAiReviewProjections).not.toHaveBeenCalled();
    expect(mocks.fetchFactReliabilities).not.toHaveBeenCalled();
  });

  it.each(["notary", "state", "unknown"] as const)(
    "keeps court-specific calculations out of %s sales",
    (venue) => {
      const sale = {
        ...EXAMPLE_SALE_RECORDS.bordeaux.sale,
        sale_venue_type: venue,
        sale_procedure: null,
        source_blocks: null,
      } as AuctionSale;
      const { container } = renderDetail("analysis", sale, false);
      expect(screen.queryByRole("tab", { name: "Statistiques" })).toBeNull();
      selectTab("Estimation");

      expect(screen.getByRole("heading", { name: "Prix et marché" })).toBeTruthy();
      expect(screen.queryByRole("link", { name: "Ajuster mes hypothèses" })).toBeNull();
      expect(container.querySelector("#calculation")).toBeNull();
    },
  );

  it.each([
    "statistiques",
    "tribunal-history",
    "stats-calendrier",
    "stats-adjudications",
    "stats-ventes",
    "stats-avocats",
  ])("opens the tribunal statistics panel from #%s without loading it in Aperçu", (anchor) => {
    const initial = renderDetail("analysis");
    expect(screen.queryByText("Statistiques du tribunal")).toBeNull();
    initial.unmount();
    window.history.replaceState(null, "", `#${anchor}`);
    const { container } = renderDetail("analysis");
    expectActivePanel(container, "statistiques");
    expect(screen.getByRole("tab", { name: "Statistiques" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByText("Statistiques du tribunal")).toBeTruthy();
  });

  it.each(["notary", "state", "online", "unknown"] as const)(
    "falls back to Aperçu for a statistics deep link on a %s sale",
    (venue) => {
      window.history.replaceState(null, "", "#statistiques");
      const { container } = renderDetail("analysis", {
        ...EXAMPLE_SALE_RECORDS.bordeaux.sale,
        sale_venue_type: venue,
        sale_procedure: null,
        source_blocks: null,
      } as AuctionSale);
      expectActivePanel(container, "apercu");
      expect(screen.queryByRole("tab", { name: "Statistiques" })).toBeNull();
      expect(screen.queryByText("Statistiques du tribunal")).toBeNull();
    },
  );

  it("keeps the announcement’s tribunal on a relocated sale and preserves price access", () => {
    const sale = { ...EXAMPLE_SALE_RECORDS.bordeaux.sale, city: "Paris" };
    const { container } = renderDetail("analysis", sale, false, true);
    selectTab("Statistiques");
    const statistics = container.querySelector("#stats-overview");
    expect(statistics?.getAttribute("data-sale-id")).toBe(sale.id);
    expect(statistics?.getAttribute("data-court-code")).toBe("tj-bordeaux");
    expect(statistics?.getAttribute("data-premium")).toBe("true");
  });

  it("preserves the no-photo and no-location states", () => {
    const { container } = renderDetail("discovery", {
      ...EXAMPLE_SALE_RECORDS.bordeaux.sale,
      media: [],
      latitude: null,
      longitude: null,
    });

    expect(screen.getByText("Visuel indisponible")).toBeTruthy();
    const location = container.querySelector("#localisation")!;
    expect(location.textContent).toContain("La carte sera disponible lorsque les coordonnées");
    expect(screen.queryByRole("button", { name: "Explorer le quartier" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Ouvrir la galerie/ })).toBeNull();
  });

  it("has no structural accessibility violations on the compact discovery page", async () => {
    const { container } = renderDetail("discovery");
    const result = await axe(container, { rules: { "color-contrast": { enabled: false } } });
    expect(
      result.violations.map((violation) => ({ id: violation.id, help: violation.help })),
    ).toEqual([]);
  });
});
