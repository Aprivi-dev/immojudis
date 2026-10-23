import type * as MapboxGL from "mapbox-gl";

export type MapboxPreviewMode = "aerial3d" | "streetLevel";

export type MapboxPreviewCamera = {
  style: string;
  zoom: number;
  pitch: number;
  bearing: number;
  terrain: boolean;
};

const MAPBOX_STANDARD_STYLE = "mapbox://styles/mapbox/standard";
const MAPBOX_STANDARD_SATELLITE_STYLE = "mapbox://styles/mapbox/standard-satellite";

export function mapboxPreviewCamera(mode: MapboxPreviewMode): MapboxPreviewCamera {
  if (mode === "aerial3d") {
    return {
      style: MAPBOX_STANDARD_SATELLITE_STYLE,
      zoom: 17.2,
      pitch: 68,
      bearing: 36,
      terrain: true,
    };
  }

  return {
    style: MAPBOX_STANDARD_STYLE,
    zoom: 18,
    pitch: 72,
    bearing: 20,
    terrain: false,
  };
}

export function mapboxPreviewModeLabel(mode: MapboxPreviewMode) {
  return mode === "aerial3d" ? "Vue aérienne 3D Mapbox" : "Vue 3D du quartier";
}

export function mapboxPreviewLoadingLabel(mode: MapboxPreviewMode) {
  return mode === "aerial3d"
    ? "Chargement de la vue aérienne 3D Mapbox..."
    : "Chargement de la vue 3D du quartier...";
}

const BUILDINGS_SOURCE = "immojudis-streets-buildings";
const BUILDINGS_LAYER = "immojudis-building-volumes";
/** Hauteur, en mètres, des bâtiments dont les données n'ont pas de hauteur. */
export const DEFAULT_BUILDING_HEIGHT_M = 6;

/**
 * Le style satellite de Mapbox n'a pas de bâtiments en 3D : on extrude ceux de Mapbox Streets
 * (hauteur relevée dans les données), dans un ton pierre clair à demi transparent : le relief se lit
 * et la photo satellite des toits reste visible au travers. Un bâtiment sans hauteur est extrudé à
 * `DEFAULT_BUILDING_HEIGHT_M` mètres (pas à une hauteur estimée par Mapbox) : la 3D est schématique
 * et le visuel qui l'affiche doit le dire (« 3D schématique »).
 */
export function addMapboxBuildingVolumes(map: MapboxGL.Map) {
  if (map.getLayer(BUILDINGS_LAYER)) return;
  if (!map.getSource(BUILDINGS_SOURCE)) {
    map.addSource(BUILDINGS_SOURCE, { type: "vector", url: "mapbox://mapbox.mapbox-streets-v8" });
  }
  map.addLayer({
    id: BUILDINGS_LAYER,
    type: "fill-extrusion",
    source: BUILDINGS_SOURCE,
    "source-layer": "building",
    filter: ["all", ["==", ["get", "extrude"], "true"], ["!=", ["get", "underground"], "true"]],
    minzoom: 14,
    paint: {
      "fill-extrusion-color": "#ece6dc",
      "fill-extrusion-height": ["coalesce", ["get", "height"], DEFAULT_BUILDING_HEIGHT_M],
      "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
      "fill-extrusion-opacity": 0.55,
      "fill-extrusion-vertical-gradient": true,
    },
  });
}
