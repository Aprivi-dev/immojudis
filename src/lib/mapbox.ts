import { clamp } from "@/lib/guards";
const DEFAULT_MAPBOX_STYLE = "mapbox/streets-v12";
const DEFAULT_STATIC_IMAGE_SIZE = { width: 640, height: 360 };
const MAPBOX_STATIC_STREETS_STYLE = "mapbox/streets-v12";
const MAPBOX_STATIC_SATELLITE_STYLE = "mapbox/satellite-v9";

export const MAPBOX_ATTRIBUTION = "© Mapbox © OpenStreetMap";
export const MAPBOX_COPYRIGHT_URL = "https://www.mapbox.com/about/maps/";

export type MapboxStaticImageFormat = "png" | "jpeg" | "webp";

/**
 * Format demandé à Mapbox pour les vignettes de liste dont le style est vectoriel (carte du
 * secteur) : l'API Static Images le sert nativement (suffixe ".webp"), bien plus léger que le PNG
 * implicite. Les styles uniquement raster (satellite) renvoient déjà du JPEG. Mettre `undefined`
 * pour revenir au format implicite de Mapbox.
 */
export const MAPBOX_LIST_THUMBNAIL_FORMAT: MapboxStaticImageFormat | undefined = "webp";

/**
 * Désactive la télémétrie de Mapbox GL (envois vers events.mapbox.com) : sans consentement, la
 * carte ne doit rien transmettre d'autre que les tuiles. EVENTS_URL est un accesseur en lecture
 * seule dans la bibliothèque ; on le remplace par une valeur nulle, ce qui coupe l'envoi.
 */
export function disableMapboxTelemetry(runtime: { config?: object } | null | undefined) {
  if (!runtime?.config) return;
  try {
    Object.defineProperty(runtime.config, "EVENTS_URL", {
      value: null,
      configurable: true,
      writable: true,
    });
  } catch {
    // Configuration verrouillée : la carte fonctionne, la télémétrie reste celle de la bibliothèque.
  }
}

export function getMapboxAccessToken() {
  return (process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN ?? "").trim();
}

export function getMapboxStylePath() {
  return normalizeMapboxStyle(
    (
      process.env.NEXT_PUBLIC_MAPBOX_STYLE ??
      process.env.NEXT_PUBLIC_MAPBOX_STYLE_ID ??
      DEFAULT_MAPBOX_STYLE
    ).trim(),
  );
}

export function getMapboxStyleUrl() {
  return `mapbox://styles/${getMapboxStylePath()}`;
}

export function mapboxStaticImageUrl({
  lat,
  lng,
  zoom = 15,
  bearing,
  pitch,
  width = DEFAULT_STATIC_IMAGE_SIZE.width,
  height = DEFAULT_STATIC_IMAGE_SIZE.height,
  marker = true,
  style,
  pixelRatio = 2,
  format,
}: {
  lat: number;
  lng: number;
  zoom?: number;
  bearing?: number;
  pitch?: number;
  width?: number;
  height?: number;
  marker?: boolean;
  style?: string;
  /** 2 (défaut) ajoute le suffixe "@2x" ; 1 demande l'image à la densité normale. */
  pixelRatio?: 1 | 2;
  format?: MapboxStaticImageFormat;
}) {
  const token = getMapboxAccessToken();
  if (!token) return "";

  const stylePath = style ? normalizeMapboxStyle(style) : getMapboxStylePath();
  const safeZoom = Math.max(0, Math.min(22, zoom));
  const safeWidth = Math.max(1, Math.min(1280, Math.round(width)));
  const safeHeight = Math.max(1, Math.min(1280, Math.round(height)));
  const camera = [formatCoordinate(lng), formatCoordinate(lat), formatCoordinate(safeZoom)];
  if (bearing != null || pitch != null) {
    camera.push(formatCoordinate(clamp(bearing ?? 0, 0, 360)));
    camera.push(formatCoordinate(clamp(pitch ?? 0, 0, 85)));
  }
  const center = camera.join(",");
  const overlay = marker ? `pin-s+0f766e(${formatCoordinate(lng)},${formatCoordinate(lat)})/` : "";

  return `https://api.mapbox.com/styles/v1/${stylePath}/static/${overlay}${center}/${safeWidth}x${safeHeight}${pixelRatio === 2 ? "@2x" : ""}${
    format ? `.${format}` : ""
  }?access_token=${encodeURIComponent(token)}`;
}

export function mapboxMapUrl(lat: number, lng: number) {
  return mapboxStaticImageUrl({
    lat,
    lng,
    zoom: 15,
    width: 1280,
    height: 720,
  });
}

export function mapboxNeighborhood3dUrl(lat: number, lng: number) {
  return mapboxStaticImageUrl({
    lat,
    lng,
    zoom: 18,
    bearing: 20,
    pitch: 72,
    width: 1280,
    height: 720,
    style: MAPBOX_STATIC_STREETS_STYLE,
  });
}

/** @deprecated Kept for stored report compatibility. */
export const mapboxStreetLevelUrl = mapboxNeighborhood3dUrl;

export function mapboxAerial3dUrl(lat: number, lng: number) {
  return mapboxStaticImageUrl({
    lat,
    lng,
    zoom: 17.2,
    bearing: 36,
    pitch: 68,
    width: 1280,
    height: 720,
    style: MAPBOX_STATIC_SATELLITE_STYLE,
  });
}

export function mapboxSatelliteImageUrl({
  lat,
  lng,
  zoom = 17,
  width = DEFAULT_STATIC_IMAGE_SIZE.width,
  height = DEFAULT_STATIC_IMAGE_SIZE.height,
  marker = true,
  pixelRatio,
  format,
}: {
  lat: number;
  lng: number;
  zoom?: number;
  width?: number;
  height?: number;
  marker?: boolean;
  pixelRatio?: 1 | 2;
  format?: MapboxStaticImageFormat;
}) {
  return mapboxStaticImageUrl({
    lat,
    lng,
    zoom,
    width,
    height,
    marker,
    pixelRatio,
    format,
    style: MAPBOX_STATIC_SATELLITE_STYLE,
  });
}

export function normalizeMapboxStyle(style: string) {
  const withoutProtocol = style
    .replace(/^mapbox:\/\/styles\//, "")
    .replace(/^https:\/\/api\.mapbox\.com\/styles\/v1\//, "")
    .replace(/\/static\/.*$/, "")
    .replace(/\/tiles\/.*$/, "")
    .replace(/^\//, "")
    .replace(/\/draft$/, "");

  const parts = withoutProtocol.split("/").filter(Boolean);
  if (parts.length < 2) return DEFAULT_MAPBOX_STYLE;
  return `${parts[0]}/${parts[1]}`;
}

function formatCoordinate(value: number) {
  return Number(value.toFixed(6));
}
