const CADASTRE_API = "https://apicarto.ign.fr/api/cadastre/parcelle";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export type CadastreSurface = {
  surfaceM2: number;
  parcelId: string | null;
  sourceUrl: string;
};

const cache = new Map<string, { expiresAt: number; value: CadastreSurface | null }>();

export async function fetchCadastreSurfaceAtPoint(
  lat: number,
  lng: number,
): Promise<CadastreSurface | null> {
  const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const url = new URL(CADASTRE_API);
    url.searchParams.set("geom", JSON.stringify({ type: "Point", coordinates: [lng, lat] }));
    url.searchParams.set("_limit", "4");
    url.searchParams.set("source_ign", "PCI");
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "immojudis/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    const value = response.ok ? cadastreSurfaceFromPayload(await response.json()) : null;
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
    return value;
  } catch {
    cache.set(key, { expiresAt: Date.now() + 60_000, value: null });
    return null;
  }
}

export function cadastreSurfaceFromPayload(payload: unknown): CadastreSurface | null {
  if (!payload || typeof payload !== "object") return null;
  const features = (payload as { features?: unknown }).features;
  if (!Array.isArray(features)) return null;

  const candidates = features
    .map((feature) => {
      if (!feature || typeof feature !== "object") return null;
      const properties = (feature as { properties?: unknown }).properties;
      if (!properties || typeof properties !== "object") return null;
      const record = properties as Record<string, unknown>;
      const surface = positive(record.contenance ?? record.surface ?? record.surface_m2);
      if (!surface) return null;
      const parcelId = text(record.idu ?? record.id ?? record.id_parcelle);
      return { surfaceM2: surface, parcelId, sourceUrl: CADASTRE_API };
    })
    .filter((value): value is CadastreSurface => value != null)
    .sort((a, b) => a.surfaceM2 - b.surfaceM2);
  return candidates[0] ?? null;
}

function positive(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
