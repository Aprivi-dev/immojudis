import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import {
  analyzeMarketCandidates,
  mutationSegmentFromCode,
  resolveMarketPropertySegment,
  type MarketComparableMode,
  type MarketEngineCandidate,
  type MarketPropertySegment,
} from "@/lib/market-estimation-engine";
import { applyActiveHybridModel } from "@/lib/hybrid-market-valuation";
import {
  fetchDataGouvDvfCommune,
  fetchDataGouvParkingCommune,
  type DataGouvParkingSale,
} from "@/lib/dvf-data-gouv";
import {
  getDvfMarketStatisticsFallback,
  type DvfMarketStatisticsFallback,
} from "@/lib/dvf-market-statistics";
import { recordValuationEstimate } from "@/lib/valuation-model-registry";
import { fetchCadastreSurfaceAtPoint } from "@/lib/market-cadastre";

// ─── DVF (Demandes de Valeurs Foncières) via API Cerema ─────────────────
// Données ouvertes DGFiP, toutes les transactions immobilières de France.
// https://apidf-preprod.cerema.fr/
//
// Stratégie de marché local (adresse exacte) :
//   1. On localise la commune et sa population → rayon 100 m (ville) ou 300 m
//      (campagne).
//   2. On collecte les mutations DVF des dernières années dans une bbox couvrant
//      ce rayon (filtrage fin par distance ensuite).
//   3. Historique de l'adresse : les 5 dernières ventes de la parcelle du bien.
//   4. Base parcellaire : la dernière vente bâtie de CHAQUE parcelle du rayon
//      (une seule par parcelle) → fourchette de prix au m² (p25 / médiane / p75).

const CEREMA_BASE = "https://apidf-preprod.cerema.fr/dvf_opendata/geomutations/";
const GEO_COMMUNES = "https://geo.api.gouv.fr/communes";
const GEO_GEOCODING = "https://data.geopf.fr/geocodage/search";
const DVF_USER_AGENT = "immojudis/1.0 (+https://immojudis-dezt.vercel.app/contact)";
const PAGE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const COMMUNE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Au-delà de ce nombre d'habitants on considère la commune comme urbaine
// (rayon resserré à 100 m) ; en deçà, rural / périurbain (rayon 300 m).
const URBAN_POPULATION_THRESHOLD = 10_000;
const HISTORY_YEARS = 6; // millésimes DVF balayés (≈ profondeur publiée)
const MIN_BUILT_SURFACE = 9;
const MAX_DVF_PAGES = 20;
const DVF_PAGE_SIZE = 500;
const STORED_DVF_LIMIT = 2_500;

type DvfYearResult = {
  features: DvfFeature[];
  complete: boolean;
  expectedCount: number;
  error: string | null;
};

const pageCache = new Map<string, { expiresAt: number; result: DvfYearResult }>();
const communeCache = new Map<string, { expiresAt: number; value: CommuneInfo | null }>();
const geocodeCache = new Map<string, { expiresAt: number; value: ResolvedMarketLocation | null }>();
const storedDvfCache = new Map<string, { expiresAt: number; value: RadiusAnalysis | null }>();

type DvfProps = {
  idmutinvar?: string;
  datemut?: string;
  anneemut?: number;
  libnatmut?: string;
  valeurfonc?: string;
  sbati?: string;
  sterr?: string;
  nblocmut?: number;
  nbpar?: number;
  l_idpar?: string[];
  codtypbien?: string;
  libtypbien?: string;
};

type DvfFeature = {
  properties: DvfProps;
  geometry?: { type?: string; coordinates?: unknown } | null;
};

type CommuneInfo = {
  code: string;
  nom: string;
  departmentCode: string | null;
  population: number;
};
type StoredDvfRow = Pick<
  Database["public"]["Tables"]["dvf_transactions"]["Row"],
  | "id"
  | "source_mutation_id"
  | "sale_date"
  | "mutation_nature"
  | "total_price_eur"
  | "built_surface_m2"
  | "land_surface_m2"
  | "price_per_m2"
  | "property_type"
  | "dvf_property_type_code"
  | "parcel_id"
  | "latitude"
  | "longitude"
>;

export type MarketAddressSale = {
  date: string;
  totalPrice: number;
  surface: number | null;
  pricePerM2: number | null;
  type: string;
};

export type MarketEstimate = {
  source: "DVF normalisé" | "DVF data.gouv" | "DVF Cerema" | "Statistiques DVF data.gouv";
  sourceUrl?: string | null;
  sourceUpdatedAt?: string | null;
  engineVersion?: "v2" | "v3";
  engineKind?: "comparable_ensemble" | "hybrid_lightgbm";
  modelVersionId?: string | null;
  modelVersion?: string | null;
  segment?: Exclude<MarketPropertySegment, "unsupported"> | "parking";
  surfaceBasis?: "built" | "land" | "unit";
  estimationLevel?: "reliable" | "indicative";
  subjectSurfaceM2?: number | null;
  subjectSurfaceEstimated?: boolean;
  subjectSurfaceAssumption?: string | null;
  subjectSurfaceUncertaintyPct?: number | null;
  locationSource?: "provided" | "geocoded";
  locationApproximate?: boolean;
  estimatedValueEur?: number | null;
  estimatedValueLowEur?: number | null;
  estimatedValueHighEur?: number | null;
  actionable?: boolean;
  collectionComplete?: boolean;
  missingYears?: number[];
  radiusM: number;
  yearsBack: number;
  areaKind: "urban" | "rural";
  commune: string | null;
  sampleSize: number; // nombre de parcelles comparables retenues
  effectiveSampleSize?: number;
  parcelSampleSize: number;
  totalNearbySampleSize: number;
  outliersRemoved: number;
  qualityScore: number;
  qualityLabel: "forte" | "correcte" | "fragile";
  qualityWarnings: string[];
  comparableMode:
    | MarketComparableMode
    | "nearby_type_only"
    | "address_history"
    | "geographic_aggregate"
    | "unit_sales";
  geographyLevel?: "commune" | "epci" | "department" | null;
  geographyCode?: string | null;
  surfaceMinM2: number | null;
  surfaceMaxM2: number | null;
  landSurfaceMinM2?: number | null;
  landSurfaceMaxM2?: number | null;
  medianPricePerM2: number | null;
  p10PricePerM2?: number | null;
  p25PricePerM2: number | null;
  p75PricePerM2: number | null;
  p90PricePerM2?: number | null;
  minPricePerM2: number | null;
  maxPricePerM2: number | null;
  medianUnitPriceEur?: number | null;
  p10UnitPriceEur?: number | null;
  p90UnitPriceEur?: number | null;
  // Si on a un prix de référence (mise à prix, prix d'adjudication)
  deviationPct: number | null; // <0 = sous le marché, >0 = au-dessus
  annualMarketTrendPct?: number;
  marketCell?: string | null;
  predictionInterval?: {
    coverageTarget: number;
    method: string;
    p10PricePerM2: number;
    p50PricePerM2: number;
    p90PricePerM2: number;
    conformalExpansionPct: number;
  };
  modelDiagnostics?: {
    modelWeight: number;
    rawP10PricePerM2: number;
    rawP50PricePerM2: number;
    rawP90PricePerM2: number;
  } | null;
  // Les 5 dernières ventes de la parcelle du bien (historique exact).
  addressHistory: MarketAddressSale[];
  // Dernière vente de chaque parcelle du rayon (base de la fourchette).
  recentTransactions: Array<{
    date: string;
    pricePerM2: number;
    surface: number;
    landSurface?: number | null;
    totalPrice: number;
    type: string;
    distanceM: number | null;
    score?: number;
    adjustedPricePerM2?: number;
    timeAdjustmentFactor?: number;
    marketCell?: string | null;
    unitCount?: number | null;
  }>;
};

export type MarketContext = {
  ok: boolean;
  error: string | null;
  estimate: MarketEstimate | null;
};

const inputSchema = z.object({
  saleId: z.string().uuid().nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  address: z.string().max(300).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  postalCode: z.string().max(12).nullable().optional(),
  // Override optionnel ; sinon le rayon est déduit du caractère urbain/rural.
  radiusM: z.number().min(50).max(10_000).nullable().optional(),
  propertyType: z.string().nullable().optional(),
  surfaceKind: z.string().nullable().optional(),
  surfaceScope: z.string().nullable().optional(),
  pricePerM2Ref: z.number().nullable().optional(),
  surfaceM2: z.number().positive().nullable().optional(),
  landSurfaceM2: z.number().positive().nullable().optional(),
  roomsCount: z.number().int().min(0).max(200).nullable().optional(),
  surfaceEstimated: z.boolean().optional(),
  surfaceAssumption: z.string().max(300).nullable().optional(),
  surfaceUncertaintyPct: z.number().min(0).max(90).nullable().optional(),
});

type ResolvedMarketLocation = {
  lat: number;
  lng: number;
  source: "provided" | "geocoded";
  approximate: boolean;
};

// ─── Géométrie ────────────────────────────────────────────────────────────

type Ring = Array<[number, number]>;

function outerRings(geometry: DvfFeature["geometry"]): Ring[] {
  if (!geometry || !Array.isArray(geometry.coordinates)) return [];
  const coords = geometry.coordinates as unknown[];
  if (geometry.type === "MultiPolygon") {
    return coords
      .map((polygon) => firstRing(polygon))
      .filter((ring): ring is Ring => ring !== null);
  }
  if (geometry.type === "Polygon") {
    const ring = firstRing(coords);
    return ring ? [ring] : [];
  }
  return [];
}

function firstRing(polygon: unknown): Ring | null {
  if (!Array.isArray(polygon) || polygon.length === 0) return null;
  const ring = polygon[0];
  if (!Array.isArray(ring)) return null;
  const cleaned: Ring = [];
  for (const point of ring) {
    if (Array.isArray(point) && typeof point[0] === "number" && typeof point[1] === "number") {
      cleaned.push([point[0], point[1]]);
    }
  }
  return cleaned.length >= 3 ? cleaned : null;
}

function ringCentroid(ring: Ring): [number, number] {
  let x = 0;
  let y = 0;
  for (const [lng, lat] of ring) {
    x += lng;
    y += lat;
  }
  return [x / ring.length, y / ring.length];
}

function featureCentroid(geometry: DvfFeature["geometry"]): [number, number] | null {
  const rings = outerRings(geometry);
  if (rings.length === 0) return null;
  return ringCentroid(rings[0]);
}

function pointInRing(ring: Ring, lng: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInFeature(geometry: DvfFeature["geometry"], lng: number, lat: number): boolean {
  return outerRings(geometry).some((ring) => pointInRing(ring, lng, lat));
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const radius = 6_371_000;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(a));
}

function bboxAround(lat: number, lng: number, radiusM: number) {
  const dLat = radiusM / 111_000;
  const dLng = radiusM / (111_000 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return { xmin: lng - dLng, ymin: lat - dLat, xmax: lng + dLng, ymax: lat + dLat };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Récupération réseau ────────────────────────────────────────────────────

async function fetchCommune(lat: number, lng: number): Promise<CommuneInfo | null> {
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
  communeCache.set(key, { expiresAt: Date.now() + COMMUNE_CACHE_TTL_MS, value });
  return value;
}

async function resolveMarketLocation(input: {
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

async function fetchDvfYear(
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

function parcelKey(props: DvfProps): string | null {
  const ids = Array.isArray(props.l_idpar) ? props.l_idpar.filter(Boolean) : [];
  if (ids.length === 0) return null;
  return [...ids].sort().join("+");
}

// ─── Analyse à un rayon donné ───────────────────────────────────────────────

type RadiusAnalysis = {
  source: MarketEstimate["source"];
  candidates: MarketEngineCandidate[];
  addressMutations: MarketAddressSale[];
  totalNearby: number;
  collectionComplete: boolean;
  missingYears: number[];
};

async function analyzeAtRadius(
  lat: number,
  lng: number,
  radiusM: number,
  segment: Exclude<MarketPropertySegment, "unsupported">,
  commune: CommuneInfo | null,
): Promise<RadiusAnalysis> {
  const stored = await analyzeStoredDvfAtRadius(lat, lng, radiusM, segment);
  if (stored) return stored;

  const dataGouv = await analyzeDataGouvDvfAtRadius(lat, lng, radiusM, segment, commune);
  if (dataGouv && (dataGouv.collectionComplete || dataGouv.candidates.length > 0)) {
    return dataGouv;
  }

  const bbox = bboxAround(lat, lng, radiusM);
  const currentYear = new Date().getFullYear();
  const years: number[] = [];
  for (let y = currentYear; y > currentYear - HISTORY_YEARS; y -= 1) years.push(y);

  const batches = await Promise.all(years.map((year) => fetchDvfYear(bbox, year, segment)));
  const features = batches.flatMap((batch) => batch.features);
  const missingYears = years.filter((_, index) => !batches[index].complete);
  const collectionComplete = missingYears.length === 0;

  // Parcelle du bien : celle dont le polygone contient le point, sinon la plus
  // proche par centroïde (≤ 25 m).
  let subjectKey: string | null = null;
  let nearestKey: string | null = null;
  let nearestDist = Infinity;
  for (const feature of features) {
    const key = parcelKey(feature.properties);
    if (!key) continue;
    if (subjectKey == null && pointInFeature(feature.geometry, lng, lat)) subjectKey = key;
    const centroid = featureCentroid(feature.geometry);
    if (centroid) {
      const dist = haversineMeters(lat, lng, centroid[1], centroid[0]);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestKey = key;
      }
    }
  }
  if (subjectKey == null && nearestDist <= 25) subjectKey = nearestKey;

  const candidates: MarketEngineCandidate[] = [];
  const addressMutations: MarketAddressSale[] = [];
  let totalNearby = 0;

  for (const feature of features) {
    const props = feature.properties;
    if (props.libnatmut && props.libnatmut !== "Vente") continue;
    const key = parcelKey(props);
    if (!key) continue;
    const centroid = featureCentroid(feature.geometry);
    if (!centroid) continue;
    const distanceM = haversineMeters(lat, lng, centroid[1], centroid[0]);
    const candidateSegment = mutationSegmentFromCode(props.codtypbien);
    if (candidateSegment !== segment) continue;
    if ((segment === "apartment" || segment === "house") && (props.nblocmut ?? 1) !== 1) {
      continue;
    }
    if (segment === "land" && (props.nblocmut ?? 0) > 0) continue;
    const builtSurface = finiteFloat(props.sbati);
    const landSurface = finiteFloat(props.sterr);
    const primarySurface = segment === "land" ? landSurface : builtSurface;
    const price = parseFloat(props.valeurfonc ?? "");
    const date = props.datemut ?? "";
    const pricePerM2 =
      Number.isFinite(price) && primarySurface != null && primarySurface > 0
        ? price / primarySurface
        : null;

    // Historique parcellaire du même segment que le bien étudié.
    if (subjectKey && key === subjectKey && date) {
      addressMutations.push({
        date,
        totalPrice: Number.isFinite(price) ? price : 0,
        surface: primarySurface,
        pricePerM2: pricePerM2 == null ? null : Math.round(pricePerM2),
        type: props.libtypbien ?? "—",
      });
    }

    if (distanceM > radiusM) continue;
    totalNearby += 1;

    if (!Number.isFinite(price) || price <= 0 || !primarySurface || !pricePerM2) continue;
    if (segment !== "land" && primarySurface < MIN_BUILT_SURFACE) continue;
    if (key === subjectKey) continue; // l'adresse est traitée à part

    candidates.push({
      id: props.idmutinvar ?? `${key}:${date}:${price}`,
      parcelId: key,
      date,
      totalPrice: price,
      builtSurfaceM2: builtSurface,
      landSurfaceM2: landSurface,
      pricePerM2,
      propertyType: props.libtypbien ?? "—",
      segment,
      distanceM: Math.round(distanceM),
      latitude: centroid[1],
      longitude: centroid[0],
    });
  }

  // Une vente par parcelle évite qu'un immeuble ou programme très actif domine l'échantillon.
  const latestByParcel = new Map<string, MarketEngineCandidate>();
  for (const sale of candidates) {
    const existing = latestByParcel.get(sale.parcelId);
    if (!existing || sale.date > existing.date) latestByParcel.set(sale.parcelId, sale);
  }

  return {
    source: "DVF Cerema",
    candidates: [...latestByParcel.values()],
    addressMutations,
    totalNearby,
    collectionComplete,
    missingYears,
  };
}

async function analyzeDataGouvDvfAtRadius(
  lat: number,
  lng: number,
  radiusM: number,
  segment: Exclude<MarketPropertySegment, "unsupported">,
  commune: CommuneInfo | null,
): Promise<RadiusAnalysis | null> {
  if (!commune?.departmentCode) return null;
  const collection = await fetchDataGouvDvfCommune({
    location: { code: commune.code, departmentCode: commune.departmentCode },
    segment,
  });
  if (!collection) return null;

  const normalized = collection.candidates
    .map((candidate) => {
      const latitude = finiteNumber(candidate.latitude);
      const longitude = finiteNumber(candidate.longitude);
      if (latitude == null || longitude == null) return null;
      return {
        ...candidate,
        distanceM: Math.round(haversineMeters(lat, lng, latitude, longitude)),
      };
    })
    .filter((candidate): candidate is MarketEngineCandidate => candidate != null)
    .filter((candidate) => candidate.distanceM <= radiusM);
  const nearest = [...normalized].sort((a, b) => a.distanceM - b.distanceM)[0];
  const subjectParcel = nearest?.distanceM <= 25 ? nearest.parcelId : null;
  const addressMutations = normalized
    .filter((candidate) => subjectParcel && candidate.parcelId === subjectParcel)
    .map((candidate) => ({
      date: candidate.date,
      totalPrice: candidate.totalPrice,
      surface: primarySurfaceForStoredCandidate(segment, candidate),
      pricePerM2: Math.round(candidate.pricePerM2),
      type: candidate.propertyType,
    }));
  const latestByParcel = new Map<string, MarketEngineCandidate>();
  for (const candidate of normalized) {
    if (subjectParcel && candidate.parcelId === subjectParcel) continue;
    const current = latestByParcel.get(candidate.parcelId);
    if (!current || candidate.date > current.date)
      latestByParcel.set(candidate.parcelId, candidate);
  }
  return {
    source: "DVF data.gouv",
    candidates: [...latestByParcel.values()],
    addressMutations,
    totalNearby: normalized.length,
    collectionComplete: collection.complete,
    missingYears: collection.missingYears,
  };
}

async function analyzeStoredDvfAtRadius(
  lat: number,
  lng: number,
  radiusM: number,
  segment: Exclude<MarketPropertySegment, "unsupported">,
): Promise<RadiusAnalysis | null> {
  if (!storedDvfConfigured()) return null;
  const cacheKey = `${lat.toFixed(4)}:${lng.toFixed(4)}:${radiusM}:${segment}`;
  const cached = storedDvfCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const { data: latestBatch, error: batchError } = await supabaseAdmin
      .from("dvf_import_batches")
      .select("status,imported_rows,period_end")
      .eq("status", "completed")
      .gt("imported_rows", 0)
      .order("period_end", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (batchError || !latestBatch?.period_end || !recentEnough(latestBatch.period_end, 18)) {
      storedDvfCache.set(cacheKey, { expiresAt: Date.now() + 60_000, value: null });
      return null;
    }

    const bbox = bboxAround(lat, lng, radiusM);
    const minimumDate = new Date();
    minimumDate.setUTCFullYear(minimumDate.getUTCFullYear() - HISTORY_YEARS);
    const { data, error } = await supabaseAdmin
      .from("dvf_transactions")
      .select(
        "id,source_mutation_id,sale_date,mutation_nature,total_price_eur,built_surface_m2,land_surface_m2,price_per_m2,property_type,dvf_property_type_code,parcel_id,latitude,longitude",
      )
      .gte("sale_date", minimumDate.toISOString().slice(0, 10))
      .gte("latitude", bbox.ymin)
      .lte("latitude", bbox.ymax)
      .gte("longitude", bbox.xmin)
      .lte("longitude", bbox.xmax)
      .order("sale_date", { ascending: false })
      .limit(STORED_DVF_LIMIT);
    if (error) throw error;
    const rows = (data ?? []) as StoredDvfRow[];
    if (!rows.length || rows.length >= STORED_DVF_LIMIT) {
      storedDvfCache.set(cacheKey, { expiresAt: Date.now() + 60_000, value: null });
      return null;
    }

    const normalized = rows
      .map((row) => storedDvfCandidate(row, { lat, lng, segment }))
      .filter((candidate): candidate is MarketEngineCandidate => candidate != null)
      .filter((candidate) => candidate.distanceM <= radiusM);
    if (!normalized.length) {
      storedDvfCache.set(cacheKey, { expiresAt: Date.now() + 60_000, value: null });
      return null;
    }

    const nearest = [...normalized].sort((a, b) => a.distanceM - b.distanceM)[0];
    const subjectParcel = nearest?.distanceM <= 25 ? nearest.parcelId : null;
    const addressMutations = normalized
      .filter((candidate) => subjectParcel && candidate.parcelId === subjectParcel)
      .map((candidate) => ({
        date: candidate.date,
        totalPrice: candidate.totalPrice,
        surface: primarySurfaceForStoredCandidate(segment, candidate),
        pricePerM2: Math.round(candidate.pricePerM2),
        type: candidate.propertyType,
      }));
    const latestByParcel = new Map<string, MarketEngineCandidate>();
    for (const candidate of normalized) {
      if (subjectParcel && candidate.parcelId === subjectParcel) continue;
      const current = latestByParcel.get(candidate.parcelId);
      if (!current || candidate.date > current.date)
        latestByParcel.set(candidate.parcelId, candidate);
    }
    const value: RadiusAnalysis = {
      source: "DVF normalisé",
      candidates: [...latestByParcel.values()],
      addressMutations,
      totalNearby: normalized.length,
      collectionComplete: true,
      missingYears: [],
    };
    storedDvfCache.set(cacheKey, { expiresAt: Date.now() + PAGE_CACHE_TTL_MS, value });
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[dvf] corpus normalisé indisponible: ${message}`);
    storedDvfCache.set(cacheKey, { expiresAt: Date.now() + 60_000, value: null });
    return null;
  }
}

function storedDvfCandidate(
  row: StoredDvfRow,
  reference: {
    lat: number;
    lng: number;
    segment: Exclude<MarketPropertySegment, "unsupported">;
  },
): MarketEngineCandidate | null {
  const latitude = finiteNumber(row.latitude);
  const longitude = finiteNumber(row.longitude);
  const totalPrice = finiteNumber(row.total_price_eur);
  const builtSurfaceM2 = finiteNumber(row.built_surface_m2);
  const landSurfaceM2 = finiteNumber(row.land_surface_m2);
  const rowSegment =
    mutationSegmentFromCode(row.dvf_property_type_code) ??
    resolveMarketPropertySegment({ propertyType: row.property_type });
  if (
    latitude == null ||
    longitude == null ||
    totalPrice == null ||
    rowSegment !== reference.segment ||
    (row.mutation_nature && row.mutation_nature !== "Vente")
  ) {
    return null;
  }
  const primarySurface = reference.segment === "land" ? landSurfaceM2 : builtSurfaceM2;
  if (!primarySurface || (reference.segment !== "land" && primarySurface < MIN_BUILT_SURFACE)) {
    return null;
  }
  const pricePerM2 = totalPrice / primarySurface;
  return {
    id: row.source_mutation_id || row.id,
    parcelId: row.parcel_id || row.id,
    date: row.sale_date,
    totalPrice,
    builtSurfaceM2,
    landSurfaceM2,
    pricePerM2,
    propertyType: row.property_type ?? row.dvf_property_type_code ?? "—",
    segment: reference.segment,
    distanceM: Math.round(haversineMeters(reference.lat, reference.lng, latitude, longitude)),
    latitude,
    longitude,
  };
}

function primarySurfaceForStoredCandidate(
  segment: Exclude<MarketPropertySegment, "unsupported">,
  candidate: MarketEngineCandidate,
): number | null {
  return segment === "land" ? candidate.landSurfaceM2 : candidate.builtSurfaceM2;
}

function storedDvfConfigured(): boolean {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  return Boolean(url?.trim() && key?.trim());
}

function recentEnough(dateValue: string, maxAgeMonths: number): boolean {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return false;
  return monthDistance(date, new Date()) <= maxAgeMonths;
}

// ─── Cœur : estimation ──────────────────────────────────────────────────────

type BuildEstimateInput = {
  lat: number;
  lng: number;
  locationSource: "provided" | "geocoded";
  locationApproximate: boolean;
  radiusOverride: number | null;
  postalCode: string | null | undefined;
  propertyType: string | null | undefined;
  surfaceKind: string | null | undefined;
  surfaceScope: string | null | undefined;
  surfaceM2: number | null | undefined;
  landSurfaceM2: number | null | undefined;
  roomsCount: number | null | undefined;
  surfaceEstimated: boolean;
  surfaceAssumption: string | null;
  surfaceUncertaintyPct: number | null;
  pricePerM2Ref: number | null | undefined;
};

async function buildEstimate(input: BuildEstimateInput): Promise<MarketEstimate> {
  const { lat, lng } = input;
  if (isParkingProperty(input.propertyType)) return buildParkingEstimate(input);

  const resolvedSegment = resolveMarketPropertySegment({
    propertyType: input.propertyType,
    surfaceKind: input.surfaceKind,
    surfaceScope: input.surfaceScope,
  });
  if (resolvedSegment === "unsupported") {
    throw new Error("segment de bien non pris en charge par l'estimation résidentielle");
  }
  const segment = resolvedSegment;
  const subjectBuiltSurface =
    segment === "land" ? null : positiveNumber(input.surfaceM2, MIN_BUILT_SURFACE);
  let subjectLandSurface =
    positiveNumber(input.landSurfaceM2, 1) ??
    (segment === "land" && input.surfaceKind === "land"
      ? positiveNumber(input.surfaceM2, 1)
      : null);
  if (segment === "land" && !subjectLandSurface) {
    const cadastre = await fetchCadastreSurfaceAtPoint(lat, lng);
    if (cadastre) {
      subjectLandSurface = cadastre.surfaceM2;
      input.surfaceEstimated = true;
      input.surfaceAssumption = `surface cadastrale de la parcelle retenue (${Math.round(cadastre.surfaceM2)} m²), emprise exacte vendue à confirmer`;
      input.surfaceUncertaintyPct = Math.max(input.surfaceUncertaintyPct ?? 0, 35);
    }
  }
  if ((segment === "land" && !subjectLandSurface) || (segment !== "land" && !subjectBuiltSurface)) {
    throw new Error("surface compatible manquante pour le segment de bien");
  }
  const subjectSurface = segment === "land" ? subjectLandSurface : subjectBuiltSurface;
  const commune = await fetchCommune(lat, lng);
  const detailedCommune = commune
    ? { ...commune, code: officialDvfCommuneCode(commune.code, input.postalCode) }
    : null;
  const areaKind: "urban" | "rural" =
    commune && commune.population >= URBAN_POPULATION_THRESHOLD ? "urban" : "rural";

  const radii = input.radiusOverride ? [input.radiusOverride] : radiiFor(segment, areaKind);
  let analysis = await analyzeAtRadius(lat, lng, radii[0], segment, detailedCommune);
  let engineResult = analyzeMarketCandidates({
    segment,
    subjectBuiltSurfaceM2: subjectBuiltSurface,
    subjectLandSurfaceM2: subjectLandSurface,
    subjectLatitude: lat,
    subjectLongitude: lng,
    candidates: analysis.candidates,
  });
  let radiusM = radii[0];
  for (let i = 1; i < radii.length && !engineResult?.actionable; i += 1) {
    radiusM = radii[i];
    analysis = await analyzeAtRadius(lat, lng, radiusM, segment, detailedCommune);
    engineResult = analyzeMarketCandidates({
      segment,
      subjectBuiltSurfaceM2: subjectBuiltSurface,
      subjectLandSurfaceM2: subjectLandSurface,
      subjectLatitude: lat,
      subjectLongitude: lng,
      candidates: analysis.candidates,
    });
  }
  if ((!engineResult || engineResult.sampleSize < 4) && commune && subjectSurface) {
    const statisticsFallback = await getDvfMarketStatisticsFallback({
      location: {
        code: commune.code,
        name: commune.nom,
        departmentCode: commune.departmentCode,
      },
      segment,
      surfaceEstimated: input.surfaceEstimated,
      surfaceUncertaintyPct: input.surfaceUncertaintyPct,
    });
    if (statisticsFallback) {
      return buildStatisticsMarketEstimate({
        fallback: statisticsFallback,
        segment,
        subjectSurface,
        subjectLandSurface,
        subjectSurfaceEstimated: input.surfaceEstimated,
        subjectSurfaceAssumption: input.surfaceAssumption,
        subjectSurfaceUncertaintyPct: input.surfaceUncertaintyPct,
        locationSource: input.locationSource,
        locationApproximate: input.locationApproximate,
        commune: commune.nom,
        radiusM,
        yearsBack: HISTORY_YEARS,
        areaKind,
        pricePerM2Ref: input.pricePerM2Ref,
      });
    }
  }
  const radiusWidened = !input.radiusOverride && radiusM > radii[0];
  const addressHistory = analysis.addressMutations
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5);
  const recentTransactions = (engineResult?.comparables ?? []).slice(0, 8).map((candidate) => ({
    date: candidate.date,
    pricePerM2: Math.round(candidate.pricePerM2),
    surface: Math.round(candidate.primarySurfaceM2),
    landSurface: candidate.landSurfaceM2 == null ? null : Math.round(candidate.landSurfaceM2),
    totalPrice: Math.round(candidate.totalPrice),
    type: candidate.propertyType,
    distanceM: candidate.distanceM,
    score: candidate.score,
    adjustedPricePerM2: candidate.adjustedPricePerM2,
    timeAdjustmentFactor: candidate.timeAdjustmentFactor,
    marketCell: candidate.marketCell,
  }));
  let median = engineResult?.medianPricePerM2 ?? null;
  let p10 = engineResult?.p10PricePerM2 ?? null;
  const p25 = engineResult?.p25PricePerM2 ?? null;
  const p75 = engineResult?.p75PricePerM2 ?? null;
  let p90 = engineResult?.p90PricePerM2 ?? null;
  const actionable = Boolean(
    engineResult?.actionable &&
    analysis.collectionComplete &&
    !input.surfaceEstimated &&
    !input.locationApproximate,
  );
  const quality = assessEngineQuality({
    engineResult,
    actionable,
    collectionComplete: analysis.collectionComplete,
    radiusM,
  });
  if (radiusWidened) quality.qualityWarnings.unshift(`rayon élargi à ${radiusM} m`);
  if (analysis.missingYears.length) {
    quality.qualityWarnings.unshift(
      `collecte incomplète : millésime(s) ${analysis.missingYears.join(", ")}`,
    );
  }
  if (input.surfaceEstimated) {
    quality.qualityWarnings.unshift(
      input.surfaceAssumption ?? "surface du bien estimée à partir de ses caractéristiques",
    );
  }
  if (input.locationSource === "geocoded") {
    quality.qualityWarnings.unshift(
      input.locationApproximate
        ? "localisation communale approximative déduite de l’adresse"
        : "coordonnées déduites de l’adresse publiée",
    );
  }

  let engineKind: "comparable_ensemble" | "hybrid_lightgbm" = "comparable_ensemble";
  let modelVersionId: string | null = null;
  let modelVersion: string | null = null;
  let predictionInterval: MarketEstimate["predictionInterval"] = engineResult?.predictionInterval;
  let modelDiagnostics: MarketEstimate["modelDiagnostics"] = null;
  if (engineResult && median && p10 && p90) {
    const hybrid = await applyActiveHybridModel({
      segment,
      surfaceM2: segment === "land" ? (subjectLandSurface ?? 0) : (subjectBuiltSurface ?? 0),
      landSurfaceM2: subjectLandSurface,
      roomsCount: positiveInteger(input.roomsCount),
      latitude: lat,
      longitude: lng,
      comparableMedianPricePerM2: median,
      comparableP10PricePerM2: p10,
      comparableP90PricePerM2: p90,
      comparableSampleSize: engineResult.sampleSize,
      comparableQualityScore: quality.qualityScore,
      annualMarketTrendPct: engineResult.annualMarketTrendPct,
      radiusM,
    });
    if (hybrid) {
      engineKind = "hybrid_lightgbm";
      modelVersionId = hybrid.modelVersionId;
      modelVersion = hybrid.modelVersion;
      median = hybrid.p50PricePerM2;
      p10 = hybrid.p10PricePerM2;
      p90 = hybrid.p90PricePerM2;
      predictionInterval = {
        coverageTarget: hybrid.coverageTarget,
        method: `hybrid_${hybrid.calibrationMethod}`,
        p10PricePerM2: p10,
        p50PricePerM2: median,
        p90PricePerM2: p90,
        conformalExpansionPct: Math.round((p90 / median - 1) * 1_000) / 10,
      };
      modelDiagnostics = {
        modelWeight: hybrid.modelWeight,
        rawP10PricePerM2: hybrid.rawModelPrediction.p10PricePerM2,
        rawP50PricePerM2: hybrid.rawModelPrediction.p50PricePerM2,
        rawP90PricePerM2: hybrid.rawModelPrediction.p90PricePerM2,
      };
    }
  }

  const deviationPct =
    input.pricePerM2Ref != null && input.pricePerM2Ref > 0 && median
      ? ((input.pricePerM2Ref - median) / median) * 100
      : null;
  const estimatedValueEur = median && subjectSurface ? Math.round(median * subjectSurface) : null;
  let estimatedValueLowEur = p10 && subjectSurface ? p10 * subjectSurface : null;
  let estimatedValueHighEur = p90 && subjectSurface ? p90 * subjectSurface : null;
  if (!actionable && estimatedValueEur) {
    const uncertainty = Math.max(0.28, (input.surfaceUncertaintyPct ?? 0) / 100);
    estimatedValueLowEur = Math.min(
      estimatedValueLowEur ?? Infinity,
      estimatedValueEur * (1 - uncertainty),
    );
    estimatedValueHighEur = Math.max(
      estimatedValueHighEur ?? 0,
      estimatedValueEur * (1 + uncertainty),
    );
  }

  return {
    source: analysis.source,
    engineVersion: "v3",
    engineKind,
    modelVersionId,
    modelVersion,
    segment,
    surfaceBasis: segment === "land" ? "land" : "built",
    estimationLevel: actionable ? "reliable" : "indicative",
    subjectSurfaceM2: subjectSurface,
    subjectSurfaceEstimated: input.surfaceEstimated,
    subjectSurfaceAssumption: input.surfaceAssumption,
    subjectSurfaceUncertaintyPct: input.surfaceUncertaintyPct,
    locationSource: input.locationSource,
    locationApproximate: input.locationApproximate,
    estimatedValueEur,
    estimatedValueLowEur:
      estimatedValueLowEur == null ? null : Math.round(estimatedValueLowEur / 1_000) * 1_000,
    estimatedValueHighEur:
      estimatedValueHighEur == null ? null : Math.round(estimatedValueHighEur / 1_000) * 1_000,
    actionable,
    collectionComplete: analysis.collectionComplete,
    missingYears: analysis.missingYears,
    radiusM,
    yearsBack: HISTORY_YEARS,
    areaKind,
    commune: commune?.nom ?? null,
    sampleSize: engineResult?.sampleSize ?? 0,
    effectiveSampleSize: engineResult?.effectiveSampleSize ?? 0,
    parcelSampleSize: analysis.candidates.length,
    totalNearbySampleSize: analysis.totalNearby,
    outliersRemoved: engineResult?.outliersRemoved ?? 0,
    ...quality,
    comparableMode: engineResult?.mode ?? "same_type_expanded",
    surfaceMinM2: engineResult?.primarySurfaceMinM2 ?? null,
    surfaceMaxM2: engineResult?.primarySurfaceMaxM2 ?? null,
    landSurfaceMinM2: engineResult?.landSurfaceMinM2 ?? null,
    landSurfaceMaxM2: engineResult?.landSurfaceMaxM2 ?? null,
    medianPricePerM2: median,
    p10PricePerM2: p10,
    p25PricePerM2: p25,
    p75PricePerM2: p75,
    p90PricePerM2: p90,
    minPricePerM2: engineResult?.minPricePerM2 ?? null,
    maxPricePerM2: engineResult?.maxPricePerM2 ?? null,
    deviationPct,
    annualMarketTrendPct: engineResult?.annualMarketTrendPct ?? 0,
    marketCell: engineResult?.marketCell ?? null,
    predictionInterval,
    modelDiagnostics,
    addressHistory,
    recentTransactions,
  };
}

async function buildParkingEstimate(input: BuildEstimateInput): Promise<MarketEstimate> {
  const commune = await fetchCommune(input.lat, input.lng);
  if (!commune?.departmentCode) {
    throw new Error("commune introuvable pour le stationnement");
  }
  const areaKind: "urban" | "rural" =
    commune.population >= URBAN_POPULATION_THRESHOLD ? "urban" : "rural";
  const detailedCommuneCode = officialDvfCommuneCode(commune.code, input.postalCode);
  const collection = await fetchDataGouvParkingCommune({
    location: { code: detailedCommuneCode, departmentCode: commune.departmentCode },
  });
  if (!collection?.sales.length) {
    throw new Error("aucune vente unitaire de stationnement exploitable dans la commune");
  }

  const radii = input.radiusOverride
    ? [input.radiusOverride]
    : areaKind === "urban"
      ? [500, 1_000, 2_000, 5_000]
      : [1_000, 2_500, 5_000, 10_000];
  const datedSales = collection.sales
    .filter((sale) => recentEnough(sale.date, 60))
    .map((sale) => ({
      ...sale,
      distanceM: Math.round(haversineMeters(input.lat, input.lng, sale.latitude, sale.longitude)),
    }));
  let radiusM = radii[0];
  let nearby = datedSales.filter((sale) => sale.distanceM <= radiusM);
  for (let index = 1; index < radii.length && nearby.length < 8; index += 1) {
    radiusM = radii[index];
    nearby = datedSales.filter((sale) => sale.distanceM <= radiusM);
  }
  if (!nearby.length) {
    throw new Error("aucune vente unitaire de stationnement assez proche");
  }

  const filtered = filterParkingOutliers(nearby);
  const selected = filtered.sales.length ? filtered.sales : nearby;
  const prices = selected.map((sale) => sale.unitPrice).sort((a, b) => a - b);
  const median = quantile(prices, 0.5);
  const empiricalP10 = quantile(prices, 0.1);
  const empiricalP90 = quantile(prices, 0.9);
  const low = Math.max(1_000, Math.min(empiricalP10, median * 0.5));
  const high = Math.max(empiricalP90, median * 1.8);
  const roundedMedian = roundTo(median, 500);
  const roundedLow = roundTo(low, 500);
  const roundedHigh = roundTo(high, 500);
  const qualityScore = Math.max(
    28,
    Math.min(64, 32 + Math.round(Math.log10(selected.length + 1) * 18)),
  );
  const qualityWarnings = [
    "estimation indicative fondée uniquement sur les mutations DVF composées de dépendances vendues seules",
    "la catégorie DVF dépendance ne distingue pas toujours parking, garage, box et cave : fourchette volontairement large",
  ];
  if (collection.missingYears.length) {
    qualityWarnings.unshift(
      `collecte incomplète : millésime(s) ${collection.missingYears.join(", ")}`,
    );
  }
  if (input.locationApproximate) {
    qualityWarnings.unshift("localisation communale approximative déduite de l’adresse");
  }

  return {
    source: "DVF data.gouv",
    sourceUrl: "https://www.data.gouv.fr/datasets/demandes-de-valeurs-foncieres-geolocalisees",
    sourceUpdatedAt: null,
    engineVersion: "v3",
    engineKind: "comparable_ensemble",
    modelVersionId: null,
    modelVersion: null,
    segment: "parking",
    surfaceBasis: "unit",
    estimationLevel: "indicative",
    subjectSurfaceM2: 1,
    subjectSurfaceEstimated: false,
    subjectSurfaceAssumption: "une place de stationnement",
    subjectSurfaceUncertaintyPct: null,
    locationSource: input.locationSource,
    locationApproximate: input.locationApproximate,
    estimatedValueEur: roundedMedian,
    estimatedValueLowEur: roundedLow,
    estimatedValueHighEur: roundedHigh,
    actionable: false,
    collectionComplete: collection.complete,
    missingYears: collection.missingYears,
    radiusM,
    yearsBack: 5,
    areaKind,
    commune: commune.nom,
    sampleSize: selected.length,
    effectiveSampleSize: selected.length,
    parcelSampleSize: nearby.length,
    totalNearbySampleSize: datedSales.length,
    outliersRemoved: filtered.removed,
    qualityScore,
    qualityLabel: qualityScore >= 58 ? "correcte" : "fragile",
    qualityWarnings,
    comparableMode: "unit_sales",
    geographyLevel: "commune",
    geographyCode: detailedCommuneCode,
    surfaceMinM2: null,
    surfaceMaxM2: null,
    landSurfaceMinM2: null,
    landSurfaceMaxM2: null,
    medianPricePerM2: null,
    p10PricePerM2: null,
    p25PricePerM2: null,
    p75PricePerM2: null,
    p90PricePerM2: null,
    minPricePerM2: null,
    maxPricePerM2: null,
    medianUnitPriceEur: roundedMedian,
    p10UnitPriceEur: roundedLow,
    p90UnitPriceEur: roundedHigh,
    deviationPct: null,
    annualMarketTrendPct: 0,
    marketCell: `parking:commune:${detailedCommuneCode}`,
    predictionInterval: undefined,
    modelDiagnostics: null,
    addressHistory: [],
    recentTransactions: selected
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 8)
      .map((sale) => ({
        date: sale.date,
        pricePerM2: Math.round(sale.unitPrice),
        surface: sale.unitCount,
        totalPrice: Math.round(sale.totalPrice),
        type: sale.unitCount > 1 ? `${sale.unitCount} dépendances` : "Dépendance seule",
        distanceM: sale.distanceM,
        unitCount: sale.unitCount,
      })),
  };
}

function filterParkingOutliers<T extends DataGouvParkingSale>(
  sales: T[],
): {
  sales: T[];
  removed: number;
} {
  if (sales.length < 8) return { sales, removed: 0 };
  const logs = sales.map((sale) => Math.log(sale.unitPrice)).sort((a, b) => a - b);
  const q1 = quantile(logs, 0.25);
  const q3 = quantile(logs, 0.75);
  const spread = q3 - q1;
  const lower = Math.exp(q1 - 1.5 * spread);
  const upper = Math.exp(q3 + 1.5 * spread);
  const filtered = sales.filter((sale) => sale.unitPrice >= lower && sale.unitPrice <= upper);
  return { sales: filtered, removed: sales.length - filtered.length };
}

function quantile(sortedValues: number[], percentile: number): number {
  if (!sortedValues.length) return 0;
  const position = (sortedValues.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (position - lower);
}

function roundTo(value: number, precision: number): number {
  return Math.max(precision, Math.round(value / precision) * precision);
}

function isParkingProperty(propertyType: string | null | undefined): boolean {
  return /parking|stationnement|garage|\bbox\b/i.test(propertyType ?? "");
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

function buildStatisticsMarketEstimate(input: {
  fallback: DvfMarketStatisticsFallback;
  segment: Exclude<MarketPropertySegment, "unsupported">;
  subjectSurface: number;
  subjectLandSurface: number | null;
  subjectSurfaceEstimated: boolean;
  subjectSurfaceAssumption: string | null;
  subjectSurfaceUncertaintyPct: number | null;
  locationSource: "provided" | "geocoded";
  locationApproximate: boolean;
  commune: string;
  radiusM: number;
  yearsBack: number;
  areaKind: "urban" | "rural";
  pricePerM2Ref: number | null | undefined;
}): MarketEstimate {
  const median = input.fallback.medianPricePerM2;
  const estimatedValueEur = Math.round((median * input.subjectSurface) / 1_000) * 1_000;
  const estimatedValueLowEur =
    Math.round((input.fallback.p10PricePerM2 * input.subjectSurface) / 1_000) * 1_000;
  const estimatedValueHighEur =
    Math.round((input.fallback.p90PricePerM2 * input.subjectSurface) / 1_000) * 1_000;
  const qualityWarnings = [...input.fallback.qualityWarnings];
  if (input.subjectSurfaceEstimated && input.subjectSurfaceAssumption) {
    qualityWarnings.unshift(input.subjectSurfaceAssumption);
  }
  if (input.locationSource === "geocoded") {
    qualityWarnings.unshift(
      input.locationApproximate
        ? "localisation communale approximative déduite de l’adresse"
        : "coordonnées déduites de l’adresse publiée",
    );
  }
  const deviationPct =
    input.pricePerM2Ref != null && input.pricePerM2Ref > 0
      ? ((input.pricePerM2Ref - median) / median) * 100
      : null;

  return {
    source: "Statistiques DVF data.gouv",
    sourceUrl: input.fallback.sourceUrl,
    sourceUpdatedAt: input.fallback.sourceUpdatedAt,
    engineVersion: "v3",
    engineKind: "comparable_ensemble",
    modelVersionId: null,
    modelVersion: null,
    segment: input.segment,
    surfaceBasis: input.segment === "land" ? "land" : "built",
    estimationLevel: "indicative",
    subjectSurfaceM2: input.subjectSurface,
    subjectSurfaceEstimated: input.subjectSurfaceEstimated,
    subjectSurfaceAssumption: input.subjectSurfaceAssumption,
    subjectSurfaceUncertaintyPct: input.subjectSurfaceUncertaintyPct,
    locationSource: input.locationSource,
    locationApproximate: input.locationApproximate,
    estimatedValueEur,
    estimatedValueLowEur,
    estimatedValueHighEur,
    actionable: false,
    collectionComplete: true,
    missingYears: [],
    radiusM: input.radiusM,
    yearsBack: input.yearsBack,
    areaKind: input.areaKind,
    commune: input.commune,
    sampleSize: input.fallback.salesCount,
    effectiveSampleSize: input.fallback.salesCount,
    parcelSampleSize: 0,
    totalNearbySampleSize: 0,
    outliersRemoved: 0,
    qualityScore: input.fallback.qualityScore,
    qualityLabel: "fragile",
    qualityWarnings,
    comparableMode: "geographic_aggregate",
    geographyLevel: input.fallback.geographyLevel,
    geographyCode: input.fallback.geographyCode,
    surfaceMinM2: null,
    surfaceMaxM2: null,
    landSurfaceMinM2: input.segment === "land" ? input.subjectLandSurface : null,
    landSurfaceMaxM2: input.segment === "land" ? input.subjectLandSurface : null,
    medianPricePerM2: median,
    p10PricePerM2: input.fallback.p10PricePerM2,
    p25PricePerM2: input.fallback.p25PricePerM2,
    p75PricePerM2: input.fallback.p75PricePerM2,
    p90PricePerM2: input.fallback.p90PricePerM2,
    minPricePerM2: input.fallback.p10PricePerM2,
    maxPricePerM2: input.fallback.p90PricePerM2,
    deviationPct,
    annualMarketTrendPct: 0,
    marketCell: `${input.fallback.geographyLevel}:${input.fallback.geographyCode}`,
    predictionInterval: {
      coverageTarget: 0.8,
      method: "geographic_aggregate_fallback",
      p10PricePerM2: input.fallback.p10PricePerM2,
      p50PricePerM2: median,
      p90PricePerM2: input.fallback.p90PricePerM2,
      conformalExpansionPct: Math.round((input.fallback.p90PricePerM2 / median - 1) * 1_000) / 10,
    },
    modelDiagnostics: null,
    addressHistory: [],
    recentTransactions: [],
  };
}

function radiiFor(
  segment: Exclude<MarketPropertySegment, "unsupported">,
  areaKind: "urban" | "rural",
): number[] {
  if (segment === "apartment")
    return areaKind === "urban" ? [150, 300, 600, 1_000, 2_000] : [300, 600, 1_000, 2_000, 5_000];
  if (segment === "house")
    return areaKind === "urban" ? [300, 600, 1_000, 2_000, 3_000] : [500, 1_000, 2_000, 5_000];
  if (segment === "building" || segment === "commercial") {
    return areaKind === "urban" ? [500, 1_000, 2_000, 3_000] : [1_000, 2_000, 5_000];
  }
  return areaKind === "urban" ? [500, 1_000, 2_000, 5_000] : [1_000, 2_000, 5_000, 10_000];
}

function assessEngineQuality({
  engineResult,
  actionable,
  collectionComplete,
  radiusM,
}: {
  engineResult: ReturnType<typeof analyzeMarketCandidates>;
  actionable: boolean;
  collectionComplete: boolean;
  radiusM: number;
}): Pick<MarketEstimate, "qualityScore" | "qualityLabel" | "qualityWarnings"> {
  if (!engineResult) {
    return {
      qualityScore: 0,
      qualityLabel: "fragile",
      qualityWarnings: ["aucune vente du même segment exploitable"],
    };
  }
  const averageScore =
    engineResult.comparables.reduce((sum, comparable) => sum + comparable.score, 0) /
    Math.max(1, engineResult.comparables.length);
  let qualityScore = 20 + Math.min(35, engineResult.effectiveSampleSize * 6) + averageScore * 0.35;
  if (engineResult.mode === "surface_land_matched") qualityScore += 8;
  if (engineResult.mode === "same_type_expanded") qualityScore -= 15;
  if (radiusM > 1_000) qualityScore -= 8;
  if (!collectionComplete) qualityScore -= 25;
  if (!actionable) qualityScore = Math.min(qualityScore, 54);
  qualityScore = Math.max(0, Math.min(100, Math.round(qualityScore)));
  return {
    qualityScore,
    qualityLabel: qualityScore >= 78 ? "forte" : qualityScore >= 58 ? "correcte" : "fragile",
    qualityWarnings: [...engineResult.warnings],
  };
}

export function marketEstimateCacheControl(context: MarketContext): string {
  const reliable = context.estimate?.actionable === true;
  if (!context.ok) return "private, max-age=60";
  return reliable
    ? "private, max-age=86400, stale-while-revalidate=604800"
    : "private, max-age=300";
}

export async function getMarketEstimate(
  input: unknown,
  audit?: { userId: string | null; auctionSaleId?: string | null },
): Promise<MarketContext> {
  const startedAt = Date.now();
  const data = inputSchema.parse(input);

  try {
    const location = await resolveMarketLocation({
      lat: data.lat,
      lng: data.lng,
      address: data.address,
      city: data.city,
      postalCode: data.postalCode,
    });
    const estimate = await buildEstimate({
      lat: location.lat,
      lng: location.lng,
      locationSource: location.source,
      locationApproximate: location.approximate,
      radiusOverride: data.radiusM ?? null,
      postalCode: data.postalCode,
      propertyType: data.propertyType,
      surfaceKind: data.surfaceKind,
      surfaceScope: data.surfaceScope,
      surfaceM2: data.surfaceM2,
      landSurfaceM2: data.landSurfaceM2,
      roomsCount: data.roomsCount,
      surfaceEstimated: data.surfaceEstimated ?? false,
      surfaceAssumption: data.surfaceAssumption ?? null,
      surfaceUncertaintyPct: data.surfaceUncertaintyPct ?? null,
      pricePerM2Ref: data.pricePerM2Ref,
    });

    const context = { ok: true, error: null, estimate } satisfies MarketContext;
    if (audit) {
      await recordValuationEstimate({
        userId: audit.userId,
        auctionSaleId: audit.auctionSaleId ?? data.saleId ?? null,
        modelVersionId: estimate.modelVersionId ?? null,
        engineVersion: estimate.engineVersion ?? "v3",
        engineKind: estimate.engineKind ?? "comparable_ensemble",
        segment: estimate.segment!,
        marketCell: estimate.marketCell ?? null,
        requestInput: data as unknown as Record<string, unknown>,
        result: estimate as unknown as Record<string, unknown>,
        valueP10Eur: estimate.estimatedValueLowEur ?? null,
        valueP50Eur: estimate.estimatedValueEur ?? null,
        valueP90Eur: estimate.estimatedValueHighEur ?? null,
        confidenceScore: estimate.qualityScore,
        comparableCount: estimate.sampleSize,
        actionable: estimate.actionable === true,
        latencyMs: Date.now() - startedAt,
      });
    }
    return context;
  } catch (err) {
    const message = err instanceof Error ? err.message : "erreur inconnue";
    console.error("DVF fetch failed", err);
    return {
      ok: false,
      error: /segment de bien|surface compatible|adresse|coordonnées/.test(message)
        ? `Estimation automatique indisponible : ${message}.`
        : "Estimation de marché temporairement indisponible.",
      estimate: null,
    };
  }
}

function finiteFloat(value: string | undefined): number | null {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function finiteNumber(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

function monthDistance(older: Date, newer: Date): number {
  const years = newer.getUTCFullYear() - older.getUTCFullYear();
  const months = newer.getUTCMonth() - older.getUTCMonth();
  return years * 12 + months;
}

function positiveNumber(value: number | null | undefined, minimum: number): number | null {
  return value != null && Number.isFinite(value) && value >= minimum ? value : null;
}

function positiveInteger(value: number | null | undefined): number | null {
  return value != null && Number.isInteger(value) && value > 0 ? value : null;
}
