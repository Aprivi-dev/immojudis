import "server-only";
import type { MarketPropertySegment } from "@/lib/market-estimation-engine";
import type {
  CommuneInfo,
  DvfFeature,
  DvfProps,
  DvfYearResult,
  ResolvedMarketLocation,
} from "@/lib/market-server/types";
import {
  CEREMA_BASE,
  COMMUNE_CACHE_TTL_MS,
  communeCache,
  DVF_PAGE_SIZE,
  DVF_REVALIDATE_SECONDS,
  DVF_USER_AGENT,
  GEO_COMMUNES,
  GEO_GEOCODING,
  geocodeCache,
  MAX_DVF_PAGES,
  PAGE_CACHE_TTL_MS,
  pageCache,
} from "@/lib/market-server/constants";
import { bboxAround, sleep } from "@/lib/market-server/geometry";

// ─── Récupération réseau ────────────────────────────────────────────────────

export async function fetchCommune(lat: number, lng: number): Promise<CommuneInfo | null> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const cached = communeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let value: CommuneInfo | null = null;
  try {
    const url = `${GEO_COMMUNES}?lat=${lat}&lon=${lng}&fields=code,nom,codeDepartement,population&format=json`;
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": DVF_USER_AGENT },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) {
      const json = (await response.json()) as Array<{
        code?: string;
        nom?: string;
        codeDepartement?: string;
        population?: number;
      }>;
      const first = Array.isArray(json) ? json[0] : null;
      if (first?.code && first.nom) {
        value = {
          code: first.code,
          nom: first.nom,
          departmentCode: first.codeDepartement ?? null,
          population: Number(first.population) || 0,
        };
      }
    }
  } catch {
    value = null;
  }
  communeCache.set(key, {
    expiresAt: Date.now() + (value ? COMMUNE_CACHE_TTL_MS : 5 * 60 * 1000),
    value,
  });
  return value;
}

export async function resolveMarketLocation(input: {
  lat: number | null | undefined;
  lng: number | null | undefined;
  address: string | null | undefined;
  city: string | null | undefined;
  postalCode: string | null | undefined;
}): Promise<ResolvedMarketLocation> {
  if (input.lat != null && input.lng != null) {
    return { lat: input.lat, lng: input.lng, source: "provided", approximate: false };
  }

  const queries = [
    [input.address, input.postalCode, input.city],
    [input.postalCode, input.city],
    [input.city],
  ]
    .map((parts) =>
      parts
        .map((value) => value?.trim())
        .filter(Boolean)
        .join(" "),
    )
    .filter((query, index, all) => Boolean(query) && all.indexOf(query) === index);
  if (!queries.length) throw new Error("adresse ou coordonnées manquantes");

  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    const query = queries[queryIndex];
    const key = query.toLowerCase();
    const cached = geocodeCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.value) {
        return queryIndex === 0 ? cached.value : { ...cached.value, approximate: true };
      }
      continue;
    }

    try {
      const url = new URL(GEO_GEOCODING);
      url.searchParams.set("q", query);
      url.searchParams.set("limit", "1");
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": DVF_USER_AGENT },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = (await response.json()) as {
        features?: Array<{
          geometry?: { coordinates?: unknown };
          properties?: { score?: number; type?: string; _type?: string };
        }>;
      };
      const feature = json.features?.[0];
      const coordinates = feature?.geometry?.coordinates;
      if (
        !Array.isArray(coordinates) ||
        typeof coordinates[0] !== "number" ||
        typeof coordinates[1] !== "number"
      ) {
        throw new Error("aucun résultat");
      }
      const score = Number(feature?.properties?.score) || 0;
      const resultType = feature?.properties?._type ?? feature?.properties?.type ?? "";
      const value: ResolvedMarketLocation = {
        lat: coordinates[1],
        lng: coordinates[0],
        source: "geocoded",
        approximate: queryIndex > 0 || score < 0.65 || /municipality|locality/.test(resultType),
      };
      geocodeCache.set(key, { expiresAt: Date.now() + COMMUNE_CACHE_TTL_MS, value });
      return value;
    } catch {
      geocodeCache.set(key, { expiresAt: Date.now() + PAGE_CACHE_TTL_MS, value: null });
    }
  }
  throw new Error("adresse non géocodable");
}

export async function fetchDvfYear(
  bbox: ReturnType<typeof bboxAround>,
  year: number,
  segment: Exclude<MarketPropertySegment, "unsupported">,
): Promise<DvfYearResult> {
  const segmentFilter =
    segment === "apartment" ? "&codtypbien=121" : segment === "house" ? "&codtypbien=111" : "";
  const baseUrl =
    `${CEREMA_BASE}?in_bbox=${bbox.xmin},${bbox.ymin},${bbox.xmax},${bbox.ymax}` +
    `&anneemut=${year}&page_size=${DVF_PAGE_SIZE}${segmentFilter}`;
  const cached = pageCache.get(baseUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const features: DvfFeature[] = [];
  let expectedCount = 0;
  let complete = true;
  let error: string | null = null;

  for (let page = 1; page <= MAX_DVF_PAGES; page += 1) {
    const pageUrl = page === 1 ? baseUrl : `${baseUrl}&page=${page}`;
    const pageResult = await fetchDvfPage(pageUrl, year);
    if (!pageResult.ok) {
      complete = false;
      error = pageResult.error;
      break;
    }
    expectedCount = pageResult.count;
    features.push(...pageResult.features);
    if (!pageResult.hasNext || features.length >= expectedCount) break;
    if (page === MAX_DVF_PAGES) {
      complete = false;
      error = `pagination limitée à ${MAX_DVF_PAGES * DVF_PAGE_SIZE} mutations`;
    }
  }

  const result = { features, complete, expectedCount, error };
  pageCache.set(baseUrl, { expiresAt: Date.now() + PAGE_CACHE_TTL_MS, result });
  return result;
}

async function fetchDvfPage(
  url: string,
  year: number,
): Promise<
  | { ok: true; features: DvfFeature[]; count: number; hasNext: boolean }
  | { ok: false; error: string }
> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        cache: "force-cache",
        next: { revalidate: DVF_REVALIDATE_SECONDS },
        headers: { Accept: "application/json", "User-Agent": DVF_USER_AGENT },
        signal: AbortSignal.timeout(12_000),
      });
      if (response.status === 429 || response.status >= 500) {
        await sleep(350 * (attempt + 1));
        continue;
      }
      if (!response.ok) {
        console.warn(`[dvf] millésime ${year} : HTTP ${response.status}`);
        return { ok: false, error: `HTTP ${response.status}` };
      }
      const json = (await response.json()) as {
        features?: DvfFeature[];
        count?: number;
        next?: string | null;
      };
      const features = Array.isArray(json.features) ? json.features : [];
      return {
        ok: true,
        features,
        count: Number.isFinite(json.count) ? Number(json.count) : features.length,
        hasNext: Boolean(json.next),
      };
    } catch (err) {
      if (attempt === 2) {
        const message = err instanceof Error ? `${err.name} ${err.message}` : "échec réseau";
        console.warn(`[dvf] millésime ${year} : ${message}`);
        return { ok: false, error: message };
      }
      await sleep(350 * (attempt + 1));
    }
  }
  return { ok: false, error: "échec réseau" };
}

// ─── Normalisation des mutations ────────────────────────────────────────────

export function parcelKey(props: DvfProps): string | null {
  const ids = Array.isArray(props.l_idpar) ? props.l_idpar.filter(Boolean) : [];
  if (ids.length === 0) return null;
  return [...ids].sort().join("+");
}

export function officialDvfCommuneCode(
  communeCode: string,
  postalCode: string | null | undefined,
): string {
  const postal = postalCode?.trim() ?? "";
  if (communeCode === "13055" && /^130(?:0[1-9]|1[0-6])$/.test(postal)) {
    return `132${postal.slice(-2)}`;
  }
  if (communeCode === "75056" && /^750(?:0[1-9]|1\d|20)$/.test(postal)) {
    return `751${postal.slice(-2)}`;
  }
  if (communeCode === "69123" && /^6900[1-9]$/.test(postal)) {
    return `6938${postal.slice(-1)}`;
  }
  return communeCode;
}
