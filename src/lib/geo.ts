import { getMapboxAccessToken } from "@/lib/mapbox";
import { computeAcquisitionCosts } from "@/lib/profitability";
import { defaultRentPerM2 } from "@/lib/rent-reference";

export type GeoPoint = { lat: number; lng: number; label?: string };

const EARTH_KM = 6371;
const FRANCE_GEOCODING_BBOX = "-5.6,41.0,9.7,51.5";

export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

export async function geocodeAddress(q: string): Promise<GeoPoint | null> {
  const mapboxPoint = await geocodeAddressWithMapbox(q);
  if (mapboxPoint) return mapboxPoint;
  return geocodeAddressWithFrenchApi(q);
}

export function geocodeAdministrativeArea(q: string): Promise<GeoPoint | null> {
  return geocodeAddressWithMapbox(q, true);
}

async function geocodeAddressWithMapbox(
  q: string,
  administrative = false,
): Promise<GeoPoint | null> {
  const token = getMapboxAccessToken();
  if (!token) return null;

  const params = new URLSearchParams({
    q,
    access_token: token,
    autocomplete: "false",
    bbox: FRANCE_GEOCODING_BBOX,
    country: "fr",
    language: "fr",
    limit: "1",
    types: administrative
      ? "region,district"
      : "address,street,postcode,place,locality,neighborhood",
  });
  const url = `https://api.mapbox.com/search/geocode/v6/forward?${params.toString()}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      features?: Array<{
        geometry?: { coordinates?: [number, number] };
        properties?: {
          full_address?: string;
          name?: string;
          place_formatted?: string;
        };
      }>;
    };
    const feature = json.features?.[0];
    const coordinates = feature?.geometry?.coordinates;
    if (!coordinates) return null;
    const [lng, lat] = coordinates;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const label =
      feature.properties?.full_address ||
      [feature.properties?.name, feature.properties?.place_formatted].filter(Boolean).join(", ") ||
      q;

    return {
      lat,
      lng,
      label,
    };
  } catch {
    return null;
  }
}

// Fallback via the French government open API (no API key, no quota).
// https://adresse.data.gouv.fr/api-doc/adresse
async function geocodeAddressWithFrenchApi(q: string): Promise<GeoPoint | null> {
  const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      features?: Array<{
        geometry: { coordinates: [number, number] };
        properties: { label: string };
      }>;
    };
    const f = json.features?.[0];
    if (!f) return null;
    return {
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0],
      label: f.properties.label,
    };
  } catch {
    return null;
  }
}

/**
 * Rendement brut indicatif : loyer de référence annuel rapporté au coût total
 * d'acquisition (prix + émoluments, droits, honoraires et frais préalables),
 * pas au seul prix. `null` quand aucun loyer de référence local n'existe.
 */
export function estimateGrossYieldPct(
  price: number | null | undefined,
  surface: number | null | undefined,
  department: string | null | undefined,
): number | null {
  if (!price || !surface || price <= 0 || surface <= 0) return null;
  const rentPerM2 = defaultRentPerM2(department);
  if (rentPerM2 == null) return null;
  const annualRent = surface * rentPerM2 * 12;
  const { totalCost } = computeAcquisitionCosts({ price, department });
  return totalCost > 0 ? (annualRent / totalCost) * 100 : null;
}

export function pricePerM2(
  price: number | null | undefined,
  surface: number | null | undefined,
): number | null {
  if (!price || !surface || surface <= 0) return null;
  return price / surface;
}
