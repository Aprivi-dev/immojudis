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
  return mode === "aerial3d" ? "Vue 3D Mapbox" : "Vue rue Mapbox";
}

export function mapboxPreviewLoadingLabel(mode: MapboxPreviewMode) {
  return mode === "aerial3d"
    ? "Chargement de la vue 3D Mapbox..."
    : "Chargement de la vue rue Mapbox...";
}
