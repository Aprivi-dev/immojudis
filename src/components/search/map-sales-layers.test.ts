import type { Map as MapboxMap } from "mapbox-gl";
import { describe, expect, it, vi } from "vitest";
import {
  CLUSTER_LAYER_ID,
  setBoundaryData,
  updateActiveLayer,
  zoomIntoCluster,
  type QueriedMapFeature,
} from "./map-sales-layers";

function fakeMap({
  features = [],
  expansionZoom = 9,
  layers = [],
}: {
  features?: QueriedMapFeature[];
  expansionZoom?: number | null;
  layers?: string[];
} = {}) {
  const source = {
    setData: vi.fn(),
    getClusterExpansionZoom: vi.fn(
      (_id: number, callback: (error: Error | null, zoom: number | null) => void) =>
        callback(null, expansionZoom),
    ),
  };
  const map = {
    queryRenderedFeatures: vi.fn(() => features),
    getSource: vi.fn(() => source),
    getLayer: vi.fn((id: string) => (layers.includes(id) ? { id } : undefined)),
    setFilter: vi.fn(),
    easeTo: vi.fn(),
  };
  return { map, source, asMap: map as unknown as MapboxMap };
}

describe("map-sales-layers", () => {
  it("zoome sur un regroupement jusqu'au niveau où il s'ouvre, sans dépasser le zoom maximal", () => {
    const { map, asMap } = fakeMap({
      features: [
        { geometry: { type: "Point", coordinates: [2.35, 48.85] }, properties: { cluster_id: 7 } },
      ],
      expansionZoom: 17.9,
    });
    zoomIntoCluster(asMap, { x: 10, y: 20 } as never, 18);
    expect(map.queryRenderedFeatures).toHaveBeenCalledWith(
      { x: 10, y: 20 },
      { layers: [CLUSTER_LAYER_ID] },
    );
    expect(map.easeTo).toHaveBeenCalledWith({ center: [2.35, 48.85], zoom: 18, duration: 420 });
  });

  it("ne bouge pas la carte hors d'un regroupement", () => {
    const { map, asMap } = fakeMap({ features: [{ properties: {} }] });
    zoomIntoCluster(asMap, { x: 0, y: 0 } as never, 18);
    expect(map.easeTo).not.toHaveBeenCalled();
  });

  it("met en avant la vente active, et aucune sans vente active", () => {
    const { map, asMap } = fakeMap({ layers: ["immojudis-sales-active"] });
    updateActiveLayer(asMap, "vente-1");
    expect(map.setFilter).toHaveBeenLastCalledWith("immojudis-sales-active", [
      "==",
      ["get", "saleId"],
      "vente-1",
    ]);
    updateActiveLayer(asMap, null);
    expect(map.setFilter).toHaveBeenLastCalledWith("immojudis-sales-active", [
      "==",
      ["get", "saleId"],
      "__none__",
    ]);
  });

  it("vide le contour quand la recherche n'en a pas", () => {
    const { source, asMap } = fakeMap();
    setBoundaryData(asMap, null);
    expect(source.setData).toHaveBeenCalledWith({ type: "FeatureCollection", features: [] });
  });
});
