// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import {
  exampleCeilingChoices,
  exampleHeadlineFigures,
  getExampleSaleRecords,
} from "@/lib/example-sale";
import { formatPrice } from "@/lib/format";

// Dated relative to today, like /annonce-exemple: the frozen records would turn into a past sale.
const EXAMPLE_SALE_RECORDS = getExampleSaleRecords();
import type { AuctionSale } from "@/lib/types";
import type { MarketEstimate } from "@/lib/market.server";
import { AI_REVIEW_FIELD_KEYS, type AiReviewProjectionReadModel } from "@/lib/ai-review-guard";
import type { SaleUnlockStatus } from "@/lib/sale-unlocks";
import {
  AnalysisSaleDetailView,
  FreeSaleDetailView,
  UnlockedSaleDetailView,
} from "./SimplifiedSaleDetailView";

const mocks = vi.hoisted(() => ({
  fetchMarket: vi.fn(),
  fetchAiReviewProjections: vi.fn(),
  fetchFactReliabilities: vi.fn(),
  fetchUrbanism: vi.fn(),
  fetchValuePreview: vi.fn(),
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
  fetchValuePreview: mocks.fetchValuePreview,
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
      calculatedCeiling,
      sale,
      marketEstimateOverride,
      forecastQuery,
      premium,
      showUpcomingListings,
      propertyTypeVerified,
      onOpenWorkspace,
      ceiling,
      userKey,
    }: {
      ceiling?: number;
      userKey?: string;
      images?: unknown[];
      onClose?: () => void;
      saleId?: string;
      calculatedCeiling?: number | null;
      sale?: AuctionSale;
      marketEstimateOverride?: unknown;
      forecastQuery?: unknown;
      premium?: boolean;
      showUpcomingListings?: boolean;
      propertyTypeVerified?: boolean;
      onOpenWorkspace?: () => void;
    }) {
      if (forecastQuery) return <section>Prévision de l’audience chargée</section>;
      // n° 92 : « Mon plafond face au tribunal » (reçoit `ceiling`) et « Mes questions pour l'avocat ».
      if (ceiling !== undefined) {
        return <section aria-label="Mon plafond face au tribunal" data-ceiling={String(ceiling)} />;
      }
      if (userKey !== undefined) return <section aria-label="Mes questions pour l’avocat" />;
      // « Mon dossier » (SaleFileCard) : seul composant chargé à la demande qui reçoit ce plafond.
      if (calculatedCeiling !== undefined) {
        return (
          <section aria-label="Mon dossier" data-ceiling={String(calculatedCeiling)}>
            Mon dossier
            {onOpenWorkspace ? (
              <button type="button" onClick={onOpenWorkspace}>
                Ouvrir le dossier de travail
              </button>
            ) : null}
          </section>
        );
      }
      if (sale && marketEstimateOverride === undefined) {
        return (
          <section
            id="stats-overview"
            data-sale-id={sale.id}
            data-court-code={sale.tribunal_code}
            data-premium={premium ? "true" : "false"}
            data-upcoming-listings={showUpcomingListings === false ? "false" : "true"}
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
        <FreeSaleDetailView
          sale={sale}
          adjudicationStatisticsEnabled={adjudicationStatisticsEnabled}
        />
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

describe("example page ceiling", () => {
  it("starts from the example's works level, so it shows the home page ceiling", () => {
    window.localStorage.clear();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mocks.fetchAiReviewProjections.mockResolvedValue({ projections: [] });
    render(
      <QueryClientProvider client={client}>
        <AnalysisSaleDetailView
          sale={EXAMPLE_SALE_RECORDS.bordeaux.sale}
          marketEstimateOverride={EXAMPLE_SALE_RECORDS.bordeaux.marketEstimate}
          publicDemo
          defaultCeilingChoices={exampleCeilingChoices("bordeaux")}
        />
      </QueryClientProvider>,
    );
    const hero = (document.body.textContent ?? "").match(
      /Enchère plafond \(simulation\)[^C]*/,
    )?.[0];
    expect(hero).toContain(formatPrice(exampleHeadlineFigures().ceiling));
    expect(hero).toContain("Travaux");
    expect(hero).not.toContain("Plafond hors travaux");
  });
});

describe("integrated listing", () => {
  it("brings « Retour aux ventes » back to the card of this sale, in a 44 px target", () => {
    const sale = EXAMPLE_SALE_RECORDS.bordeaux.sale;
    renderDetail("analysis", sale, true);
    const back = screen.getByRole("link", { name: /Retour aux ventes/ });
    expect(back.getAttribute("href")).toBe(`/sales#sale-card-${encodeURIComponent(sale.id)}`);
    expect(back.className).toContain("min-h-11");
  });

  it("names the page the visitor came from in the back link, and keeps an explicit label", () => {
    const sale = EXAMPLE_SALE_RECORDS.bordeaux.sale;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (returnTo: string, backLabel?: string) => (
      <QueryClientProvider client={client}>
        <AnalysisSaleDetailView
          sale={sale}
          marketEstimateOverride={EXAMPLE_SALE_RECORDS.bordeaux.marketEstimate}
          publicDemo
          returnTo={returnTo}
          backLabel={backLabel}
        />
      </QueryClientProvider>
    );
    mocks.fetchAiReviewProjections.mockResolvedValue({ projections: [] });
    const { rerender } = render(view("/favoris"));
    expect(screen.getByRole("link", { name: /Retour à mes favoris/ }).getAttribute("href")).toBe(
      "/favoris",
    );
    rerender(view("/sales?city=Lyon&map=true"));
    expect(screen.getByRole("link", { name: /Retour à la carte/ }).getAttribute("href")).toBe(
      `/sales?city=Lyon&map=true#sale-card-${encodeURIComponent(sale.id)}`,
    );
    rerender(view("/annonce-exemple", "Retour aux exemples"));
    expect(screen.getByRole("link", { name: /Retour aux exemples/ })).toBeTruthy();
  });

  it("reprend sur la fiche les points à vérifier de la pastille, sous #points-a-verifier", () => {
    const sale = {
      ...EXAMPLE_SALE_RECORDS.bordeaux.sale,
      status: "upcoming",
      sale_date: "2099-01-20T09:00:00Z",
      app_surface_m2: null,
      occupancy_status: null,
    } as AuctionSale;
    renderDetail("analysis", sale, true);
    const section = document.getElementById("points-a-verifier");
    expect(section?.tagName).toBe("SECTION");
    // Offre Analyse : le point relevé dans les pièces remplace celui de la pastille, sans doublon.
    expect(section?.textContent).toContain("Occupation à confirmer");
    expect(section?.textContent).not.toContain("Occupation du bien à vérifier");
    expect(section?.textContent).toContain("La liste n’est pas exhaustive");
  });

  it("ne promet pas d'informations complémentaires tant que l'agent d'information est coupé", () => {
    renderDetail("analysis", undefined, true, true);

    for (const tab of ["Aperçu", "Prix et plafond", "Statistiques", "Travaux", "Démarches"]) {
      selectTab(tab);
      expect(document.body.textContent).not.toContain("Informations complémentaires");
      expect(document.body.textContent).not.toContain("seront ajoutées à cette annonce");
    }
  });

  it("mounts one panel at a time and supports keyboard tab navigation", () => {
    const { container } = renderDetail("analysis", undefined, true, true);

    expect(screen.getAllByRole("tab")).toHaveLength(6);
    expect(screen.getByRole("tab", { name: "Aperçu" }).getAttribute("aria-selected")).toBe("true");
    expectActivePanel(container, "apercu");

    selectTab("Prix et plafond");
    expect(screen.getByRole("tab", { name: "Prix et plafond" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expectActivePanel(container, "estimation");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Prix et plafond" }), { key: "ArrowRight" });
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
    expect(screen.getByRole("tab", { name: "Prix et plafond" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expectActivePanel(container, "estimation");
  });

  it("defers tribunal forecast loading until its disclosure opens", () => {
    const sale = EXAMPLE_SALE_RECORDS.bordeaux.sale;
    renderDetail("analysis", sale, false);
    selectTab("Prix et plafond");

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
      anchor: "tribunal-perspective",
      tab: "estimation",
      target: "tribunal-perspective",
      summary: "Perspective d’adjudication",
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
                ? "Prix et plafond"
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

  it.each(["calculation", "why-this-ceiling"])(
    "lands #%s on the always visible bid ceiling planner",
    (anchor) => {
      window.history.replaceState(null, "", `#${anchor}`);
      const { container } = renderDetail("analysis", EXAMPLE_SALE_RECORDS.bordeaux.sale, false);

      expect(
        screen.getByRole("tab", { name: "Prix et plafond" }).getAttribute("aria-selected"),
      ).toBe("true");
      const target = container.querySelector(`#${anchor}`);
      expect(target).not.toBeNull();
      expect(target?.closest("details")).toBeNull();
      expect(screen.getByRole("heading", { name: "Votre enchère plafond" })).toBeTruthy();
    },
  );

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

    expect(screen.getByRole("tab", { name: "Prix et plafond" }).getAttribute("aria-selected")).toBe(
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

    selectTab("Prix et plafond");
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

    expect(await screen.findAllByText(/Type de bien à confirmer/)).not.toHaveLength(0);
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

    expect(screen.getByRole("heading", { level: 1 }).textContent).not.toContain("Bordeaux");
    const line = screen.getByText(/localisation à confirmer/);
    expect(line.textContent).not.toContain("Bordeaux");
    expect(line.textContent).not.toContain("Gironde");
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
    selectTab("Prix et plafond");

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
    selectTab("Prix et plafond");
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
    const hearingDay = new Intl.DateTimeFormat("fr-FR", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Europe/Paris",
    }).format(new Date(EXAMPLE_SALE_RECORDS.bordeaux.sale.sale_date!));
    expect(practical.textContent).toContain(hearingDay);
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

  it("shows « Mon plafond face au tribunal » under the planner only when the statistics are open", () => {
    mocks.authUser = { id: "user-1" };
    const sale = EXAMPLE_SALE_RECORDS.bordeaux.sale;

    const open = renderDetail("analysis", sale, false, true);
    selectTab("Prix et plafond");
    const section = screen.getByRole("region", { name: "Mon plafond face au tribunal" });
    expect(Number(section.getAttribute("data-ceiling"))).toBeGreaterThan(0);
    expect(section.closest("#calculation")).not.toBeNull();
    open.unmount();

    // Statistiques fermées (drapeau), démonstration publique ou visiteur : aucune requête, aucun bloc.
    window.history.replaceState(null, "", "/");
    const closed = renderDetail("analysis", sale, false, false);
    selectTab("Prix et plafond");
    expect(screen.queryByRole("region", { name: "Mon plafond face au tribunal" })).toBeNull();
    closed.unmount();

    window.history.replaceState(null, "", "/");
    renderDetail("analysis", sale, true, true);
    selectTab("Prix et plafond");
    expect(screen.queryByRole("region", { name: "Mon plafond face au tribunal" })).toBeNull();
  });

  it("shows « Mes questions pour l'avocat » in Démarches of a judicial sale, not in the public demo", () => {
    mocks.authUser = { id: "user-1" };
    const sale = EXAMPLE_SALE_RECORDS.bordeaux.sale;

    const live = renderDetail("analysis", sale, false);
    selectTab("Démarches");
    expect(screen.getByRole("region", { name: "Mes questions pour l’avocat" })).toBeTruthy();
    live.unmount();

    window.history.replaceState(null, "", "/");
    renderDetail("analysis", sale, true);
    selectTab("Démarches");
    expect(screen.queryByRole("region", { name: "Mes questions pour l’avocat" })).toBeNull();
  });

  it("points the Estimation actions to the planner and its calculation", () => {
    renderDetail("analysis", EXAMPLE_SALE_RECORDS.bordeaux.sale, false);
    selectTab("Prix et plafond");

    expect(screen.getByRole("link", { name: "Ajuster mes hypothèses" }).getAttribute("href")).toBe(
      "#calculation",
    );
    expect(screen.getByRole("link", { name: "Voir le calcul" }).getAttribute("href")).toBe(
      "#why-this-ceiling",
    );
    expect(screen.getByRole("heading", { name: "Le calcul, étape par étape" })).toBeTruthy();
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
    selectTab("Prix et plafond");
    expect(screen.getByText("Voir les références de marché")).toBeTruthy();
  });

  it("shows Premium previews without loading analyses or mounting the works and statistics tools", async () => {
    mocks.authUser = { id: "free-account" };
    mocks.fetchValuePreview.mockResolvedValue({
      available: true,
      lowEur: 180_000,
      highEur: 220_000,
      discountPct: 32,
      reliability: "medium",
    });
    renderDetail("discovery", undefined, true, true);
    selectTab("Prix et plafond");
    expect(
      screen.getByRole("heading", {
        name: "Les comparables et les travaux avec l’offre Analyse ; l’enchère plafond aussi en débloquant cette vente",
      }),
    ).toBeTruthy();
    expect((await screen.findByRole("status")).textContent).toContain(
      "environ 32 % sous la valeur estimée",
    );
    selectTab("Travaux");
    expect(
      screen.getByRole("heading", { name: "Estimez vos travaux avec l’offre Analyse" }),
    ).toBeTruthy();
    expect(screen.queryByText("Simulateur d’enchère plafond chargé")).toBeNull();
    selectTab("Statistiques");
    expect(
      screen.getByRole("heading", {
        name: "Les statistiques du tribunal avec l’offre Analyse ou en débloquant cette vente",
      }),
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
      selectTab("Prix et plafond");

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
    const initial = renderDetail("analysis", undefined, true, true);
    expect(screen.queryByText("Statistiques du tribunal")).toBeNull();
    initial.unmount();
    window.history.replaceState(null, "", `#${anchor}`);
    const { container } = renderDetail("analysis", undefined, true, true);
    expectActivePanel(container, "statistiques");
    expect(screen.getByRole("tab", { name: "Statistiques" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByText("Statistiques du tribunal")).toBeTruthy();
  });

  it.each(["analysis", "discovery"] as const)(
    "hides the tribunal statistics, their locked card and their preview while the flag is closed (%s)",
    (access) => {
      const { container } = renderDetail(access);

      expect(screen.queryByRole("tab", { name: "Statistiques" })).toBeNull();
      expect(screen.getAllByRole("tab")).toHaveLength(5);
      expect(container.textContent).not.toContain(
        "Prix d’adjudication accessibles avec l’offre Analyse",
      );
      expect(container.textContent).not.toContain(
        "Les statistiques du tribunal avec l’offre Analyse",
      );
    },
  );

  it.each(["analysis", "discovery"] as const)(
    "falls back to Aperçu for a statistics deep link while the flag is closed (%s)",
    (access) => {
      window.history.replaceState(null, "", "#stats-adjudications");
      const { container } = renderDetail(access);

      expectActivePanel(container, "apercu");
      expect(screen.queryByRole("tab", { name: "Statistiques" })).toBeNull();
      expect(screen.queryByText("Statistiques du tribunal")).toBeNull();
      expect(container.textContent).not.toContain(
        "Prix d’adjudication accessibles avec l’offre Analyse",
      );
    },
  );

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

describe("« 3 déblocages par mois » on the sale page", () => {
  const unlockStatus = (overrides: Partial<SaleUnlockStatus> = {}): SaleUnlockStatus => ({
    saleId: EXAMPLE_SALE_RECORDS.bordeaux.sale.id,
    unlocked: false,
    unlockable: true,
    analysisAccess: false,
    limit: 3,
    used: 1,
    remaining: 2,
    periodStart: "2026-09-30T22:00:00.000Z",
    resetsAt: "2026-10-31T23:00:00.000Z",
    ...overrides,
  });

  function renderFree(status: SaleUnlockStatus | null) {
    mocks.authUser = { id: "free-account" };
    mocks.fetchValuePreview.mockResolvedValue({ available: false });
    return render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <FreeSaleDetailView
          sale={EXAMPLE_SALE_RECORDS.bordeaux.sale}
          adjudicationStatisticsEnabled
          unlockStatus={status}
        />
      </QueryClientProvider>,
    );
  }

  function renderUnlocked(sale: AuctionSale = EXAMPLE_SALE_RECORDS.bordeaux.sale) {
    mocks.authUser = { id: "free-account" };
    mocks.fetchAiReviewProjections.mockResolvedValue({ projections: [] });
    mocks.fetchFactReliabilities.mockResolvedValue({ facts: {}, source: "legacy" });
    // An unlock receives the ceiling projection of the estimate, nothing more.
    const { estimatedValueEur, actionable, qualityLabel, source, sourceUpdatedAt, sampleSize } =
      EXAMPLE_SALE_RECORDS.bordeaux.marketEstimate;
    mocks.fetchMarket.mockResolvedValue({
      status: "ready",
      estimate: {
        estimatedValueEur,
        actionable,
        qualityLabel,
        source,
        sourceUpdatedAt,
        sampleSize,
        medianPricePerM2: EXAMPLE_SALE_RECORDS.bordeaux.marketEstimate.medianPricePerM2,
        p75PricePerM2: EXAMPLE_SALE_RECORDS.bordeaux.marketEstimate.p75PricePerM2,
      },
      computedAt: "2026-10-12T08:00:00.000Z",
    });
    return render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <UnlockedSaleDetailView
          sale={sale}
          adjudicationStatisticsEnabled
          unlockStatus={unlockStatus({ unlocked: true })}
        />
      </QueryClientProvider>,
    );
  }

  it("offers the unlock, with the number left, on a locked sale of a Découverte account", () => {
    renderFree(unlockStatus());

    expect(screen.getByRole("heading", { name: "Débloquer cette vente" })).toBeTruthy();
    expect(screen.getByText("Il vous reste 2 déblocages sur 3 ce mois-ci.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Débloquer cette vente" })).toBeTruthy();
  });

  it("shows nothing about unlocking before the status is known, or to a visitor", () => {
    const pending = renderFree(null);
    expect(screen.queryByRole("button", { name: "Débloquer cette vente" })).toBeNull();
    pending.unmount();

    mocks.authUser = null;
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <FreeSaleDetailView
          sale={EXAMPLE_SALE_RECORDS.bordeaux.sale}
          unlockStatus={unlockStatus()}
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("button", { name: "Débloquer cette vente" })).toBeNull();
  });

  it("does not offer the unlock to an Analyse account", () => {
    mocks.authUser = { id: "analysis-account" };
    renderDetail("analysis", undefined, false);
    expect(screen.queryByRole("button", { name: "Débloquer cette vente" })).toBeNull();
    expect(screen.queryByText("Cette vente est débloquée")).toBeNull();
  });

  it("opens the market estimate, the bid ceiling and the statistics of an unlocked sale", async () => {
    const { container } = renderUnlocked();

    expect(screen.getByText("Cette vente est débloquée")).toBeTruthy();
    expect(screen.getByText("Il vous reste 2 déblocages sur 3 ce mois-ci.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Débloquer cette vente" })).toBeNull();
    expect(mocks.fetchMarket).toHaveBeenCalledWith({
      saleId: EXAMPLE_SALE_RECORDS.bordeaux.sale.id,
    });

    selectTab("Prix et plafond");
    expect(await screen.findByRole("heading", { name: "Le calcul, étape par étape" })).toBeTruthy();
    expect(container.querySelector("#calculation")).not.toBeNull();

    selectTab("Statistiques");
    const statistics = container.querySelector("#stats-overview");
    expect(statistics?.getAttribute("data-sale-id")).toBe(EXAMPLE_SALE_RECORDS.bordeaux.sale.id);
    expect(statistics?.getAttribute("data-premium")).toBe("true");
    // The list of the other upcoming sales of the tribunal is not sent to an unlocked account.
    expect(statistics?.getAttribute("data-upcoming-listings")).toBe("false");
  });

  it("asks nothing more than the five elements need: no fact reliability, no forecast", () => {
    renderUnlocked();

    expect(mocks.fetchFactReliabilities).not.toHaveBeenCalled();
    selectTab("Prix et plafond");
    expect(screen.queryByText("Perspective d’adjudication")).toBeNull();
    expect(screen.queryByText("Prévision de l’audience chargée")).toBeNull();
  });

  it("keeps the exports, the saved reports and the Analyse-only blocks closed on an unlocked sale", () => {
    renderUnlocked();

    // Aperçu: no risk evidence panel, only the generic « Points à vérifier » card.
    expect(screen.queryByText("Voir les sources et actions à confirmer")).toBeNull();
    // Estimation: no market evidence disclosure.
    selectTab("Prix et plafond");
    expect(screen.queryByText("Voir les références de marché")).toBeNull();
    // Travaux stays a preview of the Analyse offer.
    selectTab("Travaux");
    expect(
      screen.getByRole("heading", { name: "Estimez vos travaux avec l’offre Analyse" }),
    ).toBeTruthy();
    // Démarches: no report save/export, no work file.
    selectTab("Démarches");
    expect(screen.queryByRole("button", { name: "Export PDF" })).toBeNull();
    expect(screen.queryByText("Conserver votre analyse")).toBeNull();
    expect(screen.queryByText("Préparer le dossier de travail")).toBeNull();
  });

  it("offers « Mon dossier » (free storage) to a signed-in account, with the ceiling of the calculator", async () => {
    renderUnlocked();

    await screen.findByRole("region", { name: "Mon dossier" });
    // The unlocked sale opens the calculator: its result (once the estimate is in) is what the account can save.
    await waitFor(() =>
      expect(
        Number(screen.getByRole("region", { name: "Mon dossier" }).getAttribute("data-ceiling")),
      ).toBeGreaterThan(0),
    );
  });

  it("offers « Mon dossier » without any ceiling to a free account that has not unlocked the sale", async () => {
    renderFree(unlockStatus());

    const card = await screen.findByRole("region", { name: "Mon dossier" });
    expect(card.getAttribute("data-ceiling")).toBe("null");
  });

  it("opens the work dossier from « Mon dossier » for an Analyse account, with no « Préparer » disclosure left", async () => {
    mocks.authUser = { id: "user-1" };
    renderDetail("analysis", EXAMPLE_SALE_RECORDS.bordeaux.sale, false);

    const card = await screen.findByRole("region", { name: "Mon dossier" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Ouvrir le dossier de travail" }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    // Plus de seconde porte : le détail « Préparer le dossier de travail » a disparu de Démarches.
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /Close|Fermer/ }),
    );
    selectTab("Démarches");
    expect(screen.queryByText("Préparer le dossier de travail")).toBeNull();
  });

  it("does not offer the work dossier to a free account", async () => {
    mocks.authUser = { id: "user-1" };
    renderDetail("discovery", EXAMPLE_SALE_RECORDS.bordeaux.sale, false);

    const card = await screen.findByRole("region", { name: "Mon dossier" });
    expect(within(card).queryByRole("button", { name: "Ouvrir le dossier de travail" })).toBeNull();
  });

  it("does not show « Mon dossier » to a visitor", () => {
    renderDetail("discovery");
    expect(screen.queryByRole("region", { name: "Mon dossier" })).toBeNull();
  });

  it("states that the unlocked elements are neither legal nor financial advice", () => {
    renderUnlocked();
    expect(
      screen.getByText(/ne constituent ni un conseil juridique ni un conseil financier/),
    ).toBeTruthy();
    expect(screen.getByText(/l’enchère plafond est une simulation/)).toBeTruthy();
  });

  it("does not load the market estimate for an unlocked notary sale: no bid ceiling there", () => {
    renderUnlocked({
      ...EXAMPLE_SALE_RECORDS.bordeaux.sale,
      sale_venue_type: "notary",
      sale_procedure: null,
      source_blocks: null,
    } as AuctionSale);
    expect(mocks.fetchMarket).not.toHaveBeenCalled();
    expect(screen.queryByRole("tab", { name: "Statistiques" })).toBeNull();
  });
});
