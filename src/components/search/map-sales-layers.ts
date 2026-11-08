import type {
  CircleLayerSpecification,
  FillLayerSpecification,
  GeoJSONSource,
  LineLayerSpecification,
  Map as MapboxMap,
  PointLike,
  SymbolLayerSpecification,
} from "mapbox-gl";
import type { GeographicBoundary } from "@/lib/geographic-boundary";
import type { MapboxSaleFeatureCollection } from "@/lib/mapbox-sales";
import { MAP_ACTIVE_FILL, MAP_PALETTE, MAP_PRICE_HALO } from "@/lib/map-palette";
import {
  APPROX_RING_ICON_ID,
  APPROX_RING_SIZE,
  CLUSTER_GLYPH_OFFSET,
  CLUSTER_RADIUS,
  HIT_RADIUS,
  ACTIVE_RADIUS,
  PEPITE_GLYPH_OFFSET,
  PEPITE_ICON_ID,
  POINT_RADIUS,
  addApproxRingIcon,
  addPepiteIcon,
} from "./map-sales-style";

/**
 * Couches Mapbox de la carte de /sales (voir `MapPanel`) : source des ventes et ses regroupements,
 * points, prix, pépites, positions approximatives, point actif, cible de clic, et contour de la zone
 * recherchée. `MapPanel` crée la carte et garde la main sur ses événements.
 */

const SALES_SOURCE_ID = "immojudis-sales";
const BOUNDARY_SOURCE_ID = "immojudis-search-boundary";
const BOUNDARY_FILL_LAYER_ID = "immojudis-search-boundary-fill";
const BOUNDARY_LINE_LAYER_ID = "immojudis-search-boundary-line";
export const CLUSTER_LAYER_ID = "immojudis-sales-clusters";
const CLUSTER_COUNT_LAYER_ID = "immojudis-sales-cluster-count";
const SALE_POINT_LAYER_ID = "immojudis-sales-points";
const SALE_ACTIVE_LAYER_ID = "immojudis-sales-active";
const SALE_PRICE_LAYER_ID = "immojudis-sales-price";
export const SALE_HIT_LAYER_ID = "immojudis-sales-hit";
const SALE_PEPITE_LAYER_ID = "immojudis-sales-pepite";
const CLUSTER_PEPITE_LAYER_ID = "immojudis-sales-cluster-pepite";
const SALE_APPROX_LAYER_ID = "immojudis-sales-approx";

type GeoJSONData = Parameters<GeoJSONSource["setData"]>[0];
type MapboxFilter = NonNullable<Parameters<MapboxMap["setFilter"]>[1]>;
export type QueriedMapFeature = {
  geometry?: {
    type?: string;
    coordinates?: unknown;
  };
  properties?: Record<string, unknown>;
};

const EMPTY_ACTIVE_FILTER: MapboxFilter = ["==", ["get", "saleId"], "__none__"];
const EMPTY_BOUNDARY: Pick<GeographicBoundary, "type" | "features"> = {
  type: "FeatureCollection",
  features: [],
};

/** Remplace les ventes de la source (regroupements recalculés par Mapbox). */
export function setSalesData(map: MapboxMap, data: MapboxSaleFeatureCollection) {
  const source = map.getSource(SALES_SOURCE_ID) as GeoJSONSource | undefined;
  source?.setData(data as GeoJSONData);
}

/** Remplace le contour de la zone recherchée (vide : aucun contour). */
export function setBoundaryData(map: MapboxMap, boundary: GeographicBoundary | null) {
  const source = map.getSource(BOUNDARY_SOURCE_ID) as GeoJSONSource | undefined;
  source?.setData((boundary ?? EMPTY_BOUNDARY) as GeoJSONData);
}

/** Clic sur un regroupement : la carte zoome jusqu'au niveau où il s'ouvre. */
export function zoomIntoCluster(map: MapboxMap, point: PointLike, maxZoom: number) {
  const features = map.queryRenderedFeatures(point, { layers: [CLUSTER_LAYER_ID] });
  const feature = features[0] as QueriedMapFeature | undefined;
  const clusterId = Number(feature?.properties?.cluster_id);
  if (!Number.isFinite(clusterId)) return;
  const source = map.getSource(SALES_SOURCE_ID) as GeoJSONSource | undefined;
  source?.getClusterExpansionZoom(clusterId, (error, zoom) => {
    if (error || zoom == null) return;
    const coordinates =
      feature?.geometry?.type === "Point" && Array.isArray(feature.geometry.coordinates)
        ? feature.geometry.coordinates
        : null;
    if (!coordinates) return;
    map.easeTo({
      center: [Number(coordinates[0]), Number(coordinates[1])],
      zoom: Math.min(zoom + 0.4, maxZoom),
      duration: 420,
    });
  });
}

export function addBoundaryLayers(map: MapboxMap, boundary: GeographicBoundary | null) {
  if (map.getSource(BOUNDARY_SOURCE_ID)) return;

  map.addSource(BOUNDARY_SOURCE_ID, {
    type: "geojson",
    data: (boundary ?? EMPTY_BOUNDARY) as GeoJSONData,
  });

  const fillLayer: FillLayerSpecification = {
    id: BOUNDARY_FILL_LAYER_ID,
    type: "fill",
    source: BOUNDARY_SOURCE_ID,
    paint: {
      "fill-color": MAP_PALETTE.navy,
      "fill-opacity": 0.06,
    },
  };
  const lineLayer: LineLayerSpecification = {
    id: BOUNDARY_LINE_LAYER_ID,
    type: "line",
    source: BOUNDARY_SOURCE_ID,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": MAP_PALETTE.navy,
      "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.5, 10, 2.5, 14, 3.5],
      "line-opacity": 0.88,
      "line-dasharray": [2, 1.5],
    },
  };
  const beforeLayer = map.getLayer(CLUSTER_LAYER_ID) ? CLUSTER_LAYER_ID : undefined;
  map.addLayer(fillLayer, beforeLayer);
  map.addLayer(lineLayer, beforeLayer);
}

export function addSalesLayers(map: MapboxMap, data: MapboxSaleFeatureCollection) {
  if (map.getSource(SALES_SOURCE_ID)) return;

  map.addSource(SALES_SOURCE_ID, {
    type: "geojson",
    data: data as GeoJSONData,
    cluster: true,
    clusterMaxZoom: 13,
    clusterRadius: 54,
    // Nombre de pépites dans chaque regroupement : une petite pastille signale celles qu'il contient.
    clusterProperties: { pepites: ["+", ["get", "pepite"]] },
    generateId: true,
  });
  addPepiteIcon(map);
  addApproxRingIcon(map);

  const clusterLayer: CircleLayerSpecification = {
    id: CLUSTER_LAYER_ID,
    type: "circle",
    source: SALES_SOURCE_ID,
    filter: ["has", "point_count"],
    paint: {
      // Disque blanc liseré marine : un groupe de ventes se distingue d'une vente isolée (disque marine
      // avec son prix). L'or est réservé aux pépites.
      "circle-color": MAP_PALETTE.white,
      "circle-radius": CLUSTER_RADIUS,
      "circle-stroke-color": MAP_PALETTE.navy,
      "circle-stroke-width": 3,
      "circle-opacity": 1,
    },
  };

  const clusterCountLayer: SymbolLayerSpecification = {
    id: CLUSTER_COUNT_LAYER_ID,
    type: "symbol",
    source: SALES_SOURCE_ID,
    filter: ["has", "point_count"],
    layout: {
      "text-field": ["get", "point_count_abbreviated"],
      "text-size": 12,
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": MAP_PALETTE.navy,
      "text-halo-width": 0,
    },
  };

  const salePointLayer: CircleLayerSpecification = {
    id: SALE_POINT_LAYER_ID,
    type: "circle",
    source: SALES_SOURCE_ID,
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": MAP_PALETTE.navy,
      // The price label sits inside this dark capsule-like circle. Keeping a
      // generous radius at national zoom makes short prices readable without
      // the detached grey text halo that the old map used.
      "circle-radius": POINT_RADIUS,
      // Pépite : anneau or plus épais (le glyphe en haut à droite le double : jamais la couleur seule).
      "circle-stroke-color": [
        "case",
        ["==", ["get", "pepite"], 1],
        MAP_PALETTE.gold,
        MAP_PALETTE.white,
      ],
      "circle-stroke-width": ["case", ["==", ["get", "pepite"], 1], 4, 2],
      "circle-opacity": 0.98,
    },
  };

  const pepiteGlyphLayer: SymbolLayerSpecification = {
    id: SALE_PEPITE_LAYER_ID,
    type: "symbol",
    source: SALES_SOURCE_ID,
    filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "pepite"], 1]],
    layout: {
      "icon-image": PEPITE_ICON_ID,
      "icon-offset": PEPITE_GLYPH_OFFSET,
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  };

  const clusterPepiteLayer: SymbolLayerSpecification = {
    id: CLUSTER_PEPITE_LAYER_ID,
    type: "symbol",
    source: SALES_SOURCE_ID,
    filter: ["all", ["has", "point_count"], [">", ["get", "pepites"], 0]],
    layout: {
      "icon-image": PEPITE_ICON_ID,
      "icon-offset": CLUSTER_GLYPH_OFFSET,
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  };

  const activeLayer: CircleLayerSpecification = {
    id: SALE_ACTIVE_LAYER_ID,
    type: "circle",
    source: SALES_SOURCE_ID,
    filter: EMPTY_ACTIVE_FILTER,
    paint: {
      "circle-radius": ACTIVE_RADIUS,
      "circle-color": MAP_ACTIVE_FILL,
      "circle-stroke-color": MAP_PALETTE.goldSoft,
      "circle-stroke-width": 3,
    },
  };

  // Centre de commune ou point douteux : anneau en pointillé autour du point (un trait de cercle
  // Mapbox ne peut pas être pointillé, d'où une icône).
  const approxRingLayer: SymbolLayerSpecification = {
    id: SALE_APPROX_LAYER_ID,
    type: "symbol",
    source: SALES_SOURCE_ID,
    filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "approx"], 1]],
    layout: {
      "icon-image": APPROX_RING_ICON_ID,
      "icon-size": APPROX_RING_SIZE,
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  };

  const salePriceLayer: SymbolLayerSpecification = {
    id: SALE_PRICE_LAYER_ID,
    type: "symbol",
    source: SALES_SOURCE_ID,
    filter: ["!", ["has", "point_count"]],
    layout: {
      "text-field": ["get", "priceLabel"],
      "text-size": 12,
      "text-anchor": "center",
      "text-offset": [0, 0],
      "text-padding": 2,
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": MAP_PALETTE.white,
      "text-halo-color": MAP_PRICE_HALO,
      "text-halo-width": 1,
      "text-halo-blur": 0,
    },
  };

  const hitLayer: CircleLayerSpecification = {
    id: SALE_HIT_LAYER_ID,
    type: "circle",
    source: SALES_SOURCE_ID,
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-radius": HIT_RADIUS,
      "circle-color": MAP_PALETTE.navy,
      "circle-opacity": 0.01,
    },
  };

  map.addLayer(clusterLayer);
  map.addLayer(clusterCountLayer);
  map.addLayer(activeLayer);
  map.addLayer(salePointLayer);
  map.addLayer(approxRingLayer);
  map.addLayer(salePriceLayer);
  map.addLayer(pepiteGlyphLayer);
  map.addLayer(clusterPepiteLayer);
  map.addLayer(hitLayer);
}

export function updateActiveLayer(map: MapboxMap, activeId: string | null | undefined) {
  if (!map.getLayer(SALE_ACTIVE_LAYER_ID)) return;
  const filter: MapboxFilter = activeId ? ["==", ["get", "saleId"], activeId] : EMPTY_ACTIVE_FILTER;
  map.setFilter(SALE_ACTIVE_LAYER_ID, filter);
}
