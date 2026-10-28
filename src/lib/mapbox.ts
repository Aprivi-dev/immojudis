import { clamp } from "@/lib/guards";
const DEFAULT_MAPBOX_STYLE = "mapbox/streets-v12";
const DEFAULT_STATIC_IMAGE_SIZE = { width: 640, height: 360 };
const MAPBOX_STATIC_STREETS_STYLE = "mapbox/streets-v12";
const MAPBOX_STATIC_SATELLITE_STYLE = "mapbox/satellite-v9";
const DEFAULT_PIN_COLOR = "0f766e";
/** Repère blanc sur satellite : le sarcelle disparaît sur les parcelles boisées (1,5 à 1,9:1). */
const SATELLITE_PIN_COLOR = "ffffff";

export const MAPBOX_ATTRIBUTION = "© Mapbox © OpenStreetMap";
/**
 * Crédits d'une image satellite : l'imagerie de Mapbox est fournie par Maxar (entre autres), à
 * mentionner en plus. Les images de rue gardent `MAPBOX_ATTRIBUTION`. La date de prise de vue n'est
 * pas connue de l'application.
 */
export const MAPBOX_SATELLITE_ATTRIBUTION = "© Mapbox © OpenStreetMap © Maxar";
export const MAPBOX_SATELLITE_IMAGERY_DATE_NOTICE = "Date d’imagerie inconnue";
export const MAPBOX_COPYRIGHT_URL = "https://www.mapbox.com/about/maps/";

export type MapboxStaticImageFormat = "png" | "jpeg" | "webp";

/**
 * Format demandé à Mapbox pour les vignettes de liste : l'API Static Images le sert nativement
 * (suffixe ".webp"). Mesuré le 16/10/2026 sur une vignette 512×384 @2x : carte du secteur
 * 137 Ko en PNG contre 43 Ko en WebP, satellite 228 Ko en JPEG contre 180 Ko en WebP. Mettre
 * `undefined` pour revenir au format implicite de Mapbox.
 */
export const MAPBOX_LIST_THUMBNAIL_FORMAT: MapboxStaticImageFormat | undefined = "webp";

/**
 * Textes que Mapbox écrit lui-même (nom du canevas, bouton des crédits, zoom…) : sans cette table,
 * `language: "fr"` ne traduit que les étiquettes du fond de carte. Clés de `defaultLocale` de
 * mapbox-gl. `mapTitle` nomme la carte (rôle « region » du canevas) : un nom propre à chaque carte
 * évite plusieurs régions « Map » identiques sur une page.
 */
export function mapboxLocaleFr(mapTitle = "Carte interactive") {
  return {
    "AttributionControl.ToggleAttribution": "Afficher ou masquer les crédits de la carte",
    "FullscreenControl.Enter": "Passer en plein écran",
    "FullscreenControl.Exit": "Quitter le plein écran",
    "GeolocateControl.FindMyLocation": "Trouver ma position",
    "GeolocateControl.LocationNotAvailable": "Position indisponible",
    "LogoControl.Title": "Page d’accueil de Mapbox",
    "Map.Title": mapTitle,
    "NavigationControl.ResetBearing": "Réorienter la carte vers le nord",
    "NavigationControl.ZoomIn": "Zoomer",
    "NavigationControl.ZoomOut": "Dézoomer",
    "ScrollZoomBlocker.CtrlMessage": "Utilisez Ctrl + molette pour zoomer la carte",
    "ScrollZoomBlocker.CmdMessage": "Utilisez ⌘ + molette pour zoomer la carte",
    "TouchPanBlocker.Message": "Utilisez deux doigts pour déplacer la carte",
  } as const;
}

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
  pinColor = DEFAULT_PIN_COLOR,
  style,
  pixelRatio = 2,
  format,
  overlay: extraOverlay,
}: {
  lat: number;
  lng: number;
  zoom?: number;
  bearing?: number;
  pitch?: number;
  width?: number;
  height?: number;
  marker?: boolean;
  /** Couleur hexadécimale du repère, sans « # ». */
  pinColor?: string;
  /** Recouvrement déjà encodé (par exemple `geojson(...)`), tracé sous le repère. */
  overlay?: string;
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
  const pin = marker ? `pin-s+${pinColor}(${formatCoordinate(lng)},${formatCoordinate(lat)})` : "";
  const overlays = [extraOverlay, pin].filter(Boolean).join(",");
  const overlay = overlays && `${overlays}/`;

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
  pinColor = SATELLITE_PIN_COLOR,
  pixelRatio,
  format,
}: {
  lat: number;
  lng: number;
  zoom?: number;
  width?: number;
  height?: number;
  marker?: boolean;
  /** Couleur hexadécimale du repère, sans « # ». */
  pinColor?: string;
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
    pinColor,
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
