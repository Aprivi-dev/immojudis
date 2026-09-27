const GEOCODING_URL = "https://data.geopf.fr/geocodage/search";

export type CadastralNeighborhoodPoint = {
  lat: number;
  lng: number;
  source: string;
  kind: "listing" | "address" | "street" | "parcel-centroid";
};

type AddressInput = {
  address: string | null | undefined;
  postalCode: string | null | undefined;
  city: string | null | undefined;
};

export async function geocodeCadastralNeighborhood(
  input: AddressInput,
  signal: AbortSignal,
): Promise<CadastralNeighborhoodPoint | null> {
  const address = input.address?.trim();
  if (!address) return null;

  const query = [address, input.postalCode?.trim(), input.city?.trim()].filter(Boolean).join(" ");
  const url = new URL(GEOCODING_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "1");

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) return null;
    return parseCadastralGeocode(await response.json(), input);
  } catch {
    return null;
  }
}

export function parseCadastralGeocode(
  payload: unknown,
  input: AddressInput,
): CadastralNeighborhoodPoint | null {
  if (!payload || typeof payload !== "object") return null;
  const features = (payload as { features?: unknown }).features;
  if (!Array.isArray(features)) return null;

  for (const feature of features) {
    if (!feature || typeof feature !== "object") continue;
    const geometry = (feature as { geometry?: unknown }).geometry;
    const properties = (feature as { properties?: unknown }).properties;
    if (!geometry || typeof geometry !== "object") continue;
    if (!properties || typeof properties !== "object") continue;

    const coordinates = (geometry as { coordinates?: unknown }).coordinates;
    const values = properties as Record<string, unknown>;
    const type = values.type ?? values._type;
    const score = values.score;
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
    const [lng, lat] = coordinates;
    if (typeof lat !== "number" || typeof lng !== "number") continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    if (type !== "housenumber" && type !== "address" && type !== "street") continue;
    if (typeof score !== "number" || score < 0.7) continue;

    const postalCode = input.postalCode?.trim();
    if (postalCode && values.postcode !== postalCode) continue;
    const city = input.city?.trim();
    if (city && normalizePlaceName(values.city) !== normalizePlaceName(city)) continue;

    return {
      lat,
      lng,
      source: type === "street" ? "Rue localisée par l’IGN" : "Adresse géocodée par l’IGN",
      kind: type === "street" ? "street" : "address",
    };
  }
  return null;
}

function normalizePlaceName(value: unknown): string {
  return typeof value === "string"
    ? value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9]+/g, " ")
        .trim()
        .toLowerCase()
    : "";
}
