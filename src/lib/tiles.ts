import {
  MAPBOX_ATTRIBUTION,
  MAPBOX_COPYRIGHT_URL,
  getMapboxAccessToken,
  getMapboxStylePath,
} from "@/lib/mapbox";

const TILE_SIZE = 256;
const MAX_MERCATOR_LAT = 85.05112878;
const DEFAULT_OSM_TILE_TEMPLATE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";
export const OSM_COPYRIGHT_URL = "https://www.openstreetmap.org/copyright";
export { MAPBOX_ATTRIBUTION, MAPBOX_COPYRIGHT_URL };

export type LatLng = {
  lat: number;
  lng: number;
};

export type WorldPixel = {
  x: number;
  y: number;
};

export type ViewportSize = {
  width: number;
  height: number;
};

export function getOsmTileTemplate() {
  const fromEnv = (
    process.env.NEXT_PUBLIC_OSM_TILE_URL ??
    process.env.NEXT_PUBLIC_OSM_TILE_TEMPLATE ??
    process.env.VITE_OSM_TILE_URL ??
    process.env.VITE_OSM_TILE_TEMPLATE
  )?.trim();
  return fromEnv || getMapboxTileTemplate() || DEFAULT_OSM_TILE_TEMPLATE;
}

export function getTileAttribution(template = getOsmTileTemplate()) {
  if (template.includes("mapbox.com")) {
    return {
      href: MAPBOX_COPYRIGHT_URL,
      label: MAPBOX_ATTRIBUTION,
    };
  }

  return {
    href: OSM_COPYRIGHT_URL,
    label: OSM_ATTRIBUTION,
  };
}

function getMapboxTileTemplate() {
  const token = getMapboxAccessToken();
  if (!token) return "";

  const style = getMapboxStylePath();
  if (!style) return "";

  return `https://api.mapbox.com/styles/v1/${style}/tiles/256/{z}/{x}/{y}?access_token=${encodeURIComponent(
    token,
  )}`;
}

export function osmTileUrlFromXYZ(
  z: number,
  x: number,
  y: number,
  template = getOsmTileTemplate(),
) {
  const max = 2 ** z;
  const wrappedX = ((x % max) + max) % max;
  const clampedY = Math.max(0, Math.min(max - 1, y));
  const subdomains = ["a", "b", "c"];
  const subdomain = subdomains[Math.abs(wrappedX + clampedY) % subdomains.length];

  return template
    .replaceAll("{z}", String(z))
    .replaceAll("{x}", String(wrappedX))
    .replaceAll("{y}", String(clampedY))
    .replaceAll("{s}", subdomain);
}

export function osmTileUrl(lat: number, lng: number, z = 15): string {
  const projected = projectLatLngToTile(lat, lng, z);
  return osmTileUrlFromXYZ(z, Math.floor(projected.x), Math.floor(projected.y));
}

export function osmTileMarkerPct(lat: number, lng: number, z = 15) {
  const projected = projectLatLngToTile(lat, lng, z);
  return {
    left: (projected.x - Math.floor(projected.x)) * 100,
    top: (projected.y - Math.floor(projected.y)) * 100,
  };
}

export function openStreetMapUrl(lat: number, lng: number, zoom = 17) {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=${zoom}/${lat}/${lng}`;
}

export function openStreetMapQueryUrl(query: string) {
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(query.trim())}`;
}

export function clampOsmZoom(zoom: number, min = 3, max = 18) {
  return Math.max(min, Math.min(max, Math.round(zoom)));
}

export function projectLatLngToWorldPixel(lat: number, lng: number, zoom: number): WorldPixel {
  const sinLat = Math.sin((clampLatitude(lat) * Math.PI) / 180);
  const scale = TILE_SIZE * 2 ** zoom;

  return {
    x: ((lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale,
  };
}

export function unprojectWorldPixelToLatLng(x: number, y: number, zoom: number): LatLng {
  const scale = TILE_SIZE * 2 ** zoom;
  const lng = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));

  return {
    lat: clampLatitude(lat),
    lng: normalizeLongitude(lng),
  };
}

export function mapBoundsFromCenter(center: LatLng, zoom: number, viewport: ViewportSize) {
  const centerPixel = projectLatLngToWorldPixel(center.lat, center.lng, zoom);
  const northWest = unprojectWorldPixelToLatLng(
    centerPixel.x - viewport.width / 2,
    centerPixel.y - viewport.height / 2,
    zoom,
  );
  const southEast = unprojectWorldPixelToLatLng(
    centerPixel.x + viewport.width / 2,
    centerPixel.y + viewport.height / 2,
    zoom,
  );

  return {
    north: northWest.lat,
    south: southEast.lat,
    east: southEast.lng,
    west: northWest.lng,
  };
}

function projectLatLngToTile(lat: number, lng: number, zoom: number) {
  const world = projectLatLngToWorldPixel(lat, lng, zoom);
  return {
    x: world.x / TILE_SIZE,
    y: world.y / TILE_SIZE,
  };
}

function clampLatitude(lat: number) {
  return Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
}

function normalizeLongitude(lng: number) {
  const normalized = ((((lng + 180) % 360) + 360) % 360) - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
}
