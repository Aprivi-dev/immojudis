export type StreetViewTarget = {
  lat?: number | null;
  lng?: number | null;
  pano?: string | null;
  /**
   * Kept for display and future geocoding. The Maps Embed streetview mode
   * accepts coordinates or a panorama id, not a free-form address.
   */
  address?: string | null;
};

export type StreetViewEmbedOptions = {
  heading?: number;
  pitch?: number;
  fov?: number;
};

export function getGoogleMapsEmbedApiKey() {
  return (process.env.NEXT_PUBLIC_GOOGLE_MAPS_EMBED_API_KEY ?? "").trim();
}

export function hasStreetViewCoordinates(target: StreetViewTarget) {
  return isValidLatitude(target.lat) && isValidLongitude(target.lng);
}

export function hasStreetViewTarget(target: StreetViewTarget) {
  return Boolean(target.pano?.trim()) || hasStreetViewCoordinates(target);
}

/**
 * Build the Google Maps Embed API URL for an interactive Street View iframe.
 *
 * Street View Embed accepts a panorama id or latitude/longitude. An address
 * alone is intentionally not sent as `location`: Google documents that
 * parameter as coordinates for this mode, so an address needs geocoding (or
 * a stored panorama id) before it can be embedded reliably.
 */
export function buildStreetViewEmbedUrl(
  target: StreetViewTarget,
  apiKey = getGoogleMapsEmbedApiKey(),
  options: StreetViewEmbedOptions = {},
) {
  const key = apiKey.trim();
  if (!key || !hasStreetViewTarget(target)) return "";

  const params = new URLSearchParams({
    key,
    language: "fr",
    region: "fr",
    source: "outdoor",
  });
  const pano = target.pano?.trim();

  if (pano) {
    params.set("pano", pano);
    if (hasStreetViewCoordinates(target)) {
      params.set("location", formatLocation(target.lat as number, target.lng as number));
    }
  } else {
    params.set("location", formatLocation(target.lat as number, target.lng as number));
  }

  if (options.heading != null && Number.isFinite(options.heading)) {
    params.set("heading", String(clamp(options.heading, -180, 360)));
  }
  if (options.pitch != null && Number.isFinite(options.pitch)) {
    params.set("pitch", String(clamp(options.pitch, -90, 90)));
  }
  if (options.fov != null && Number.isFinite(options.fov)) {
    params.set("fov", String(clamp(options.fov, 10, 100)));
  }

  return `https://www.google.com/maps/embed/v1/streetview?${params.toString()}`;
}

export function streetViewTargetLabel(target: StreetViewTarget) {
  const address = target.address?.trim();
  if (address) return address;
  if (hasStreetViewCoordinates(target)) {
    return `${formatCoordinate(target.lat as number)}, ${formatCoordinate(target.lng as number)}`;
  }
  return "cette annonce";
}

function isValidLatitude(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value >= -180 && value <= 180;
}

function formatLocation(lat: number, lng: number) {
  return `${formatCoordinate(lat)},${formatCoordinate(lng)}`;
}

function formatCoordinate(value: number) {
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
