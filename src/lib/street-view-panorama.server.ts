import "server-only";
import { getGoogleMapsEmbedApiKey, type StreetViewPanorama } from "@/lib/street-view";

const METADATA_URL = "https://maps.googleapis.com/maps/api/streetview/metadata";
/** A Google car panorama farther than this does not show the listing's street. */
const MAX_PANORAMA_DISTANCE_M = 120;
const DIRECT_RADIUS_M = 50;
const RING_DISTANCE_M = 40;
const RING_RADIUS_M = 50;
const RING_BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315];
const REQUEST_TIMEOUT_MS = 4_000;
const EARTH_RADIUS_M = 6_371_000;

type Candidate = { pano: string; lat: number; lng: number; date: string | null };

/**
 * Nearest Google Street View car panorama around a point.
 *
 * The Embed API opens the nearest panorama of any kind, which is often a
 * user-contributed photo sphere (shop interiors, drone shots). Google's own
 * imagery is the only one that reliably shows the street and the facade, so
 * this looks for it with the free metadata endpoint: first at the point, then
 * on a small ring around it, and keeps the closest one.
 */
export async function findStreetViewPanorama(
  lat: number,
  lng: number,
  apiKey = getGoogleMapsEmbedApiKey(),
): Promise<StreetViewPanorama> {
  if (!apiKey) return { status: "unavailable", reason: "not_configured" };

  const direct = await lookup(lat, lng, DIRECT_RADIUS_M, apiKey);
  const candidates = direct
    ? [direct]
    : (
        await Promise.all(
          RING_BEARINGS.map((bearing) => {
            const probe = destination(lat, lng, bearing, RING_DISTANCE_M);
            return lookup(probe.lat, probe.lng, RING_RADIUS_M, apiKey);
          }),
        )
      ).filter((candidate): candidate is Candidate => candidate !== null);

  let best: (Candidate & { distanceM: number }) | null = null;
  for (const candidate of candidates) {
    const distanceM = distanceMeters(candidate.lat, candidate.lng, lat, lng);
    if (distanceM <= MAX_PANORAMA_DISTANCE_M && (!best || distanceM < best.distanceM)) {
      best = { ...candidate, distanceM };
    }
  }
  if (!best) return { status: "unavailable", reason: "no_google_imagery" };

  return {
    status: "ready",
    pano: best.pano,
    // Standing on the property, any heading is as good as another.
    heading: best.distanceM >= 3 ? Math.round(bearingDegrees(best.lat, best.lng, lat, lng)) : null,
    distanceM: Math.round(best.distanceM),
    date: best.date,
  };
}

async function lookup(
  lat: number,
  lng: number,
  radius: number,
  apiKey: string,
): Promise<Candidate | null> {
  const params = new URLSearchParams({
    location: `${lat.toFixed(6)},${lng.toFixed(6)}`,
    radius: String(radius),
    source: "outdoor",
    key: apiKey,
  });
  const response = await fetch(`${METADATA_URL}?${params.toString()}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Street View metadata HTTP ${response.status}`);
  const body = (await response.json()) as {
    status?: string;
    pano_id?: string;
    copyright?: string;
    date?: string;
    location?: { lat?: number; lng?: number };
    error_message?: string;
  };
  if (body.status === "ZERO_RESULTS" || body.status === "NOT_FOUND") return null;
  if (body.status !== "OK") {
    throw new Error(
      `Street View metadata ${body.status ?? "unknown"}: ${body.error_message ?? ""}`,
    );
  }
  if (!isGoogleImagery(body.copyright, body.pano_id)) return null;
  const location = body.location;
  if (
    !body.pano_id ||
    typeof location?.lat !== "number" ||
    typeof location.lng !== "number" ||
    !Number.isFinite(location.lat) ||
    !Number.isFinite(location.lng)
  ) {
    return null;
  }
  return { pano: body.pano_id, lat: location.lat, lng: location.lng, date: body.date ?? null };
}

/** Google car imagery is credited "© Google"; contributed photo spheres carry their author. */
export function isGoogleImagery(copyright: string | undefined, panoId: string | undefined) {
  if (!copyright || !panoId) return false;
  return /^©\s*(\d{4}\s+)?Google$/i.test(copyright.trim()) && !panoId.startsWith("CAoS");
}

export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearingDegrees(lat1: number, lng1: number, lat2: number, lng2: number) {
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const dLng = toRadians(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

function destination(lat: number, lng: number, bearing: number, distance: number) {
  const delta = distance / EARTH_RADIUS_M;
  const theta = toRadians(bearing);
  const phi1 = toRadians(lat);
  const lambda1 = toRadians(lng);
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta),
  );
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
    );
  return { lat: toDegrees(phi2), lng: toDegrees(lambda2) };
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function toDegrees(value: number) {
  return (value * 180) / Math.PI;
}
