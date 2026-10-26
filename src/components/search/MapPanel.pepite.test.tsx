// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapPanel, type MapPanelProps } from "./MapPanel";
import type { AuctionSale } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event?: unknown) => void>(),
  sources: new Map<string, Record<string, unknown>>(),
  layers: [] as Array<Record<string, unknown>>,
  images: [] as Array<{ id: string; options: unknown }>,
  setHtml: vi.fn(),
}));

vi.mock("@/lib/mapbox", () => ({
  getMapboxAccessToken: () => "test-token",
  disableMapboxTelemetry: vi.fn(),
  getMapboxStyleUrl: () => "test-style",
  MAPBOX_ATTRIBUTION: "Mapbox",
  MAPBOX_COPYRIGHT_URL: "https://www.mapbox.com/about/maps/",
  mapboxSatelliteImageUrl: vi.fn(),
  mapboxLocaleFr: () => ({}),
}));
vi.mock("mapbox-gl", () => ({
  default: {
    Map: class {
      canvas = document.createElement("canvas");
      on(event: string, layerOrCallback: unknown, maybeCallback?: unknown) {
        const callback = typeof layerOrCallback === "function" ? layerOrCallback : maybeCallback;
        const key = typeof layerOrCallback === "string" ? `${event}:${layerOrCallback}` : event;
        if (typeof callback === "function")
          mocks.handlers.set(key, callback as (event?: unknown) => void);
      }
      getCanvas() {
        return this.canvas;
      }
      addSource(id: string, source: Record<string, unknown>) {
        mocks.sources.set(id, source);
      }
      getSource(id: string) {
        return mocks.sources.has(id) ? { setData: vi.fn() } : undefined;
      }
      addLayer(layer: Record<string, unknown>) {
        mocks.layers.push(layer);
      }
      getLayer(id: string) {
        return mocks.layers.find((layer) => layer.id === id);
      }
      hasImage(id: string) {
        return mocks.images.some((image) => image.id === id);
      }
      addImage(id: string, _data: unknown, options: unknown) {
        mocks.images.push({ id, options });
      }
      setFilter() {}
      getBounds() {
        return null;
      }
      getZoom() {
        return 6;
      }
      fitBounds() {}
      easeTo() {}
      resize() {}
      remove() {}
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
        return this;
      }
      remove() {}
      isOpen() {
        return true;
      }
    },
  },
}));

beforeEach(() => {
  mocks.handlers.clear();
  mocks.sources.clear();
  mocks.layers.length = 0;
  mocks.images.length = 0;
  mocks.setHtml.mockClear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  // Canvas 2D minimal : jsdom n'en fournit pas.
  const context = new Proxy(
    { getImageData: () => ({ width: 40, height: 40, data: new Uint8ClampedArray(6400) }) },
    {
      get: (target, key) => (key in target ? target[key as keyof typeof target] : () => undefined),
      set: () => true,
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function sale(id: string, extra: Partial<AuctionSale> = {}): AuctionSale {
  return {
    id,
    city: "Bordeaux",
    property_type: "apartment",
    latitude: 44.84,
    longitude: -0.58,
    starting_price_eur: 90_000,
    media: [],
    ...extra,
  } as unknown as AuctionSale;
}

async function showMap(props: Partial<MapPanelProps> = {}) {
  const view = render(
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
    />,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  act(() => mocks.handlers.get("load")?.());
  return view;
}

describe("carte : repère « Pépite »", () => {
  it("marque les pépites d'une propriété numérique et compte celles de chaque regroupement", async () => {
    await showMap({
      sales: [sale("pepite-1"), sale("autre")],
      pepiteSaleIds: new Set(["pepite-1"]),
    });
    const source = mocks.sources.get("immojudis-sales")!;
    const features = (source.data as { features: Array<{ properties: Record<string, unknown> }> })
      .features;
    expect(features.map((feature) => feature.properties.pepite)).toEqual([1, 0]);
    expect(source.clusterProperties).toEqual({ pepites: ["+", ["get", "pepite"]] });
    // Rien d'autre que le drapeau : aucun montant autre que le prix affiché de la mise à prix.
    expect(JSON.stringify(features)).not.toMatch(/plafond|ceiling|probable/i);
  });

  it("épaissit l'anneau et ajoute un glyphe en haut à droite, sur les ventes et sur les regroupements", async () => {
    await showMap({ sales: [sale("pepite-1")], pepiteSaleIds: new Set(["pepite-1"]) });
    const point = mocks.layers.find((layer) => layer.id === "immojudis-sales-points")!;
    const paint = point.paint as Record<string, unknown[]>;
    expect(JSON.stringify(paint["circle-stroke-width"])).toBe(
      JSON.stringify(["case", ["==", ["get", "pepite"], 1], 4, 2]),
    );
    expect(JSON.stringify(paint["circle-stroke-color"])).toContain("#c98d45");

    const glyph = mocks.layers.find((layer) => layer.id === "immojudis-sales-pepite")!;
    expect(glyph.type).toBe("symbol");
    expect((glyph.layout as Record<string, unknown>)["icon-offset"]).toEqual([16, -16]);
    const clusterGlyph = mocks.layers.find(
      (layer) => layer.id === "immojudis-sales-cluster-pepite",
    )!;
    expect(JSON.stringify(clusterGlyph.filter)).toContain('"pepites"');
    expect(mocks.images).toEqual([{ id: "immojudis-pepite", options: { pixelRatio: 2 } }]);
  });

  it("garde un rayon de capture d'au moins 48 px (24 px de rayon)", async () => {
    await showMap({ sales: [sale("pepite-1")], pepiteSaleIds: new Set(["pepite-1"]) });
    const hit = mocks.layers.find((layer) => layer.id === "immojudis-sales-hit")!;
    expect((hit.paint as Record<string, number>)["circle-radius"]).toBeGreaterThanOrEqual(24);
  });

  it("écrit la légende et le texte pour lecteur d'écran « dont N pépites »", async () => {
    await showMap({
      sales: [sale("p1"), sale("p2"), sale("autre")],
      pepiteSaleIds: new Set(["p1", "p2"]),
    });
    expect(screen.getByText(/Pépite \(2\) · anneau doré/)).toBeTruthy();
    expect(document.body.textContent).toMatch(/Dont 2 pépites, repérées par un anneau doré épais/);
  });

  it("n'ajoute aucune légende sans pépite (mode shadow)", async () => {
    await showMap({ sales: [sale("a")], pepiteSaleIds: new Set() });
    expect(document.body.textContent).not.toMatch(/pépite/i);
  });

  it("n'ajoute pas de glyphe sans canvas 2D : l'anneau reste", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await showMap({ sales: [sale("p1")], pepiteSaleIds: new Set(["p1"]) });
    expect(mocks.images).toEqual([]);
    expect(mocks.layers.some((layer) => layer.id === "immojudis-sales-points")).toBe(true);
  });

  it("écrit une ligne « Pépite » échappée dans la fenêtre, sans montant de pépite", async () => {
    await showMap({
      sales: [sale("p1", { city: "<img src=x onerror=alert(1)>" })],
      pepiteSaleIds: new Set(["p1"]),
      selectedSaleId: "p1",
    });
    act(() => {
      mocks.handlers.get("click:immojudis-sales-hit")?.({
        features: [{ properties: { saleId: "p1" } }],
        preventDefault: vi.fn(),
      });
    });
    const html = mocks.setHtml.mock.calls.at(-1)?.[0] as string;
    expect(html).toContain("<strong>Pépite</strong> · repère calculé automatiquement");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toMatch(/plafond estimée|Prix probable|fourchette/);
  });

  it("n'écrit pas la ligne pour une vente qui n'est pas une pépite", async () => {
    await showMap({
      sales: [sale("a")],
      pepiteSaleIds: new Set(["p1"]),
    });
    act(() => {
      mocks.handlers.get("click:immojudis-sales-hit")?.({
        features: [{ properties: { saleId: "a" } }],
        preventDefault: vi.fn(),
      });
    });
    expect(mocks.setHtml.mock.calls.at(-1)?.[0]).not.toContain("Pépite");
  });
});
