// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapPanel, type MapPanelProps } from "./MapPanel";
import type { AuctionSale } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  token: "test-token",
  throws: false,
  handlers: new Map<string, (event?: unknown) => void>(),
  remove: vi.fn(),
  addTo: vi.fn(),
  setData: vi.fn(),
  setHtml: vi.fn(),
  easeTo: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  popupOpen: true,
}));
vi.mock("@/lib/mapbox", () => ({
  getMapboxAccessToken: () => mocks.token,
  getMapboxStyleUrl: () => "test-style",
  MAPBOX_ATTRIBUTION: "Mapbox",
  MAPBOX_COPYRIGHT_URL: "https://www.mapbox.com/about/maps/",
  mapboxSatelliteImageUrl: vi.fn(),
}));
vi.mock("mapbox-gl", () => ({
  default: {
    Map: class {
      canvas = document.createElement("canvas");
      constructor() {
        if (mocks.throws) throw new Error("WebGL unavailable");
      }
      on(event: string, layerOrCallback: unknown, maybeCallback?: unknown) {
        const callback = typeof layerOrCallback === "function" ? layerOrCallback : maybeCallback;
        const key = typeof layerOrCallback === "string" ? `${event}:${layerOrCallback}` : event;
        if (typeof callback === "function")
          mocks.handlers.set(key, callback as (event?: unknown) => void);
      }
      getCanvas() {
        return this.canvas;
      }
      getSource() {
        return { setData: mocks.setData };
      }
      getLayer() {
        return undefined;
      }
      getBounds() {
        return null;
      }
      getZoom() {
        return 6;
      }
      zoomIn() {
        mocks.zoomIn();
      }
      zoomOut() {
        mocks.zoomOut();
      }
      fitBounds() {}
      easeTo() {
        mocks.easeTo();
      }
      resize() {}
      remove() {
        mocks.remove();
      }
    },
    Popup: class {
      setLngLat() {
        return this;
      }
      setHTML(html: string) {
        mocks.setHtml(html);
        return this;
      }
      addTo() {
        mocks.addTo();
        mocks.popupOpen = true;
        return this;
      }
      remove() {
        mocks.popupOpen = false;
      }
      isOpen() {
        return mocks.popupOpen;
      }
    },
  },
}));
beforeEach(() => {
  vi.useFakeTimers();
  mocks.token = "test-token";
  mocks.throws = false;
  mocks.handlers.clear();
  mocks.popupOpen = true;
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mapElement(props: Partial<MapPanelProps> = {}) {
  return (
    <MapPanel
      sales={[]}
      preview
      showDpeLegend={false}
      hoveredSaleId={null}
      selectedSaleId={null}
      isLoading={false}
      searchAsMove={false}
      onHover={vi.fn()}
      onSelect={vi.fn()}
      onViewportChange={vi.fn()}
      onSearchAsMoveChange={vi.fn()}
      {...props}
    />
  );
}

async function showMap(props: Partial<MapPanelProps> = {}) {
  const view = render(mapElement(props));
  // Mapbox est chargé à la demande (import dynamique) : on laisse la promesse se résoudre.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return view;
}

describe("public map resilience", () => {
  it("keeps popup facts public and never presents missing analysis as low risk", async () => {
    const sale = {
      id: "preview",
      title: "Private source title",
      city: "Bordeaux",
      property_type: "apartment",
      latitude: 44.84,
      longitude: -0.58,
      starting_price_eur: 90000,
      app_surface_m2: 60,
      investment_score: 85,
      media: [],
    } as unknown as AuctionSale;
    await showMap({ sales: [sale], selectedSaleId: sale.id });
    act(() => mocks.handlers.get("load")?.());
    const html = mocks.setHtml.mock.calls.at(-1)?.[0];
    expect(html).toContain("Appartement à Bordeaux");
    expect(html).toContain("Position approximative");
    expect(html).toContain("Risque Analyse");
    expect(html).not.toContain("Faible");
    expect(html).not.toContain("Score 85");
    expect(html).not.toContain("Private source title");
  });
  it("masks an authenticated popup value when the review projection is blocked", async () => {
    const sale = {
      id: "guarded",
      title: "Maison privée à Bordeaux",
      city: "Bordeaux",
      property_type: "house",
      latitude: 44.84,
      longitude: -0.58,
      starting_price_eur: 90_000,
      app_surface_m2: 60,
      source_blocks: { dpe_classe: "D" },
      media: [],
    } as unknown as AuctionSale;
    await showMap({
      sales: [sale],
      preview: false,
      showDpeLegend: true,
      selectedSaleId: sale.id,
      aiReviewStatus: "ready",
      aiReviewBySaleId: {
        [sale.id]: [
          {
            auction_sale_id: sale.id,
            field_key: "sale.starting_price_eur",
            review_state: "unresolved",
            citation_status: "not_required",
            is_publishable: false,
            source_name: "AGRASC",
            source_url: "https://example.test/source/1",
          },
        ],
      },
    });
    act(() => mocks.handlers.get("load")?.());
    const html = mocks.setHtml.mock.calls.at(-1)?.[0] as string;
    expect(html).toContain("Prix non communiqué");
    expect(html).toContain("Vente à confirmer");
    expect(html).not.toContain("90 000");
    expect(html).not.toContain("Maison privée à Bordeaux");
  });
  it("replaces a stalled loading state after 12 seconds and recovers on a late load", async () => {
    await showMap();
    expect(screen.getByText("Chargement de la carte")).toBeTruthy();
    act(() => vi.advanceTimersByTime(12000));
    expect(screen.queryByText("Chargement de la carte")).toBeNull();
    expect(screen.getByText(/annonces restent accessibles dans la liste/)).toBeTruthy();
    act(() => mocks.handlers.get("load")?.());
    expect(screen.queryByText(/annonces restent accessibles dans la liste/)).toBeNull();
    expect(screen.getByText(/Positions approximatives/)).toBeTruthy();
    expect(screen.queryByText("DPE")).toBeNull();
  });
  it("clears the load timer on unmount", async () => {
    const view = await showMap();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.remove).toHaveBeenCalledOnce();
  });
  it("keeps a helpful fallback when no token is configured", async () => {
    mocks.token = "";
    await showMap();
    expect(screen.getByText(/continuer à consulter les annonces dans la liste/)).toBeTruthy();
    expect(screen.queryByText("Chargement de la carte")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not crash the search page when WebGL cannot start", async () => {
    mocks.throws = true;
    await showMap();
    expect(screen.getByText(/annonces restent accessibles dans la liste/)).toBeTruthy();
    expect(screen.queryByText("Chargement de la carte")).toBeNull();
  });

  it("shows the exact official contour returned for the selected geographic label", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              boundary: {
                type: "FeatureCollection",
                features: [],
                label: "Bordeaux",
                level: "commune",
                bbox: [-0.7, 44.8, -0.5, 44.95],
                sourceUrl: "https://www.data.gouv.fr/datasets/contours-administratifs",
              },
            }),
            { status: 200 },
          ),
      ),
    );

    await showMap({ geographicLabel: "Bordeaux" });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("map-boundary-label")).toBeTruthy();
    expect(screen.getByText(/Bordeaux/)).toBeTruthy();
    expect(screen.getByText(/source officielle/).getAttribute("href")).toBe(
      "https://www.data.gouv.fr/datasets/contours-administratifs",
    );
  });

  it("offers an explicit viewport search after a manual map movement", async () => {
    const onSearchViewport = vi.fn();
    const sale = {
      id: "mapped",
      title: "Bien à Bordeaux",
      city: "Bordeaux",
      property_type: "apartment",
      latitude: 44.84,
      longitude: -0.58,
      starting_price_eur: 90_000,
      media: [],
    } as unknown as AuctionSale;

    await showMap({
      preview: false,
      showDpeLegend: true,
      sales: [sale],
      onSearchViewport,
    });
    act(() => mocks.handlers.get("load")?.());

    fireEvent.click(screen.getByRole("button", { name: "Zoomer" }));
    act(() => mocks.handlers.get("moveend")?.());

    const searchButton = screen.getByTestId("search-map-viewport");
    expect(searchButton.textContent).toContain("Rechercher dans cette zone");
    fireEvent.click(searchButton);
    expect(onSearchViewport).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("search-map-viewport")).toBeNull();
  });

  it("updates the selected popup in place when its authenticated detail arrives", async () => {
    const sale = {
      id: "detail-sale",
      title: "Annonce légère",
      city: "Bordeaux",
      property_type: "apartment",
      latitude: 44.84,
      longitude: -0.58,
      starting_price_eur: 90_000,
      media: [],
    } as unknown as AuctionSale;
    const detail = {
      ...sale,
      title: "Maison détaillée",
      property_type: "house",
      source_blocks: { dpe_classe: "D" },
    } as unknown as AuctionSale;

    const view = await showMap({
      sales: [sale],
      preview: false,
      showDpeLegend: true,
      selectedSaleId: sale.id,
      selectedSaleDetailLoading: true,
    });
    act(() => mocks.handlers.get("load")?.());
    const easeCallsBeforeDetail = mocks.easeTo.mock.calls.length;
    const htmlWhileLoading = mocks.setHtml.mock.calls.at(-1)?.[0] as string;
    expect(htmlWhileLoading).toContain("Chargement des informations complémentaires");

    act(() => {
      view.rerender(
        mapElement({
          sales: [sale],
          preview: false,
          showDpeLegend: true,
          selectedSaleId: sale.id,
          selectedSaleDetail: detail,
          selectedSaleDetailLoading: false,
        }),
      );
    });

    expect(mocks.easeTo.mock.calls.length).toBe(easeCallsBeforeDetail);
    expect(mocks.setHtml.mock.calls.at(-1)?.[0]).toContain("Maison détaillée");
  });

  it("reopens the same cached detailed popup after the user closes it", async () => {
    const sale = {
      id: "cached-sale",
      title: "Annonce légère",
      city: "Bordeaux",
      property_type: "apartment",
      latitude: 44.84,
      longitude: -0.58,
      starting_price_eur: 90_000,
      media: [],
    } as unknown as AuctionSale;
    const detail = {
      ...sale,
      title: "Maison détaillée en cache",
      property_type: "house",
    } as unknown as AuctionSale;

    await showMap({
      sales: [sale],
      preview: false,
      showDpeLegend: true,
      selectedSaleId: sale.id,
      selectedSaleDetail: detail,
    });
    act(() => mocks.handlers.get("load")?.());
    const addCallsBeforeReopen = mocks.addTo.mock.calls.length;
    mocks.popupOpen = false;

    act(() => {
      mocks.handlers.get("click:immojudis-sales-hit")?.({
        features: [{ properties: { saleId: sale.id } }],
        preventDefault: vi.fn(),
      });
    });

    expect(mocks.addTo.mock.calls.length).toBe(addCallsBeforeReopen + 1);
    expect(mocks.setHtml.mock.calls.at(-1)?.[0]).toContain("Maison détaillée en cache");
  });

  it("ignores a late detail response after the selected popup was closed", async () => {
    const firstSale = {
      id: "first-sale",
      title: "Première annonce",
      city: "Bordeaux",
      property_type: "apartment",
      latitude: 44.84,
      longitude: -0.58,
      starting_price_eur: 90_000,
      media: [],
    } as unknown as AuctionSale;
    const staleDetail = {
      ...firstSale,
      title: "Détail d’un autre compte",
    } as unknown as AuctionSale;

    const view = await showMap({
      sales: [firstSale],
      preview: false,
      showDpeLegend: true,
      selectedSaleId: firstSale.id,
      selectedSaleDetailLoading: true,
    });
    act(() => mocks.handlers.get("load")?.());
    mocks.popupOpen = false;
    const setHtmlCallsBeforeLateResponse = mocks.setHtml.mock.calls.length;
    const addCallsBeforeLateResponse = mocks.addTo.mock.calls.length;
    const easeCallsBeforeLateResponse = mocks.easeTo.mock.calls.length;

    act(() => {
      view.rerender(
        mapElement({
          sales: [firstSale],
          preview: false,
          showDpeLegend: true,
          selectedSaleId: firstSale.id,
          selectedSaleDetail: staleDetail,
          selectedSaleDetailLoading: false,
        }),
      );
    });

    expect(mocks.popupOpen).toBe(false);
    expect(mocks.setHtml.mock.calls.length).toBe(setHtmlCallsBeforeLateResponse);
    expect(mocks.addTo.mock.calls.length).toBe(addCallsBeforeLateResponse);
    expect(mocks.easeTo.mock.calls.length).toBe(easeCallsBeforeLateResponse);
  });
});
