import { createServerFn } from "@tanstack/react-start";
import { setResponseHeaders } from "@tanstack/react-start/server";
import { z } from "zod";

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
const DVF_USER_AGENT = "immojudis/1.0 (+https://immojudis-dezt.vercel.app/contact)";
const PAGE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const COMMUNE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Au-delà de ce nombre d'habitants on considère la commune comme urbaine
// (rayon resserré à 100 m) ; en deçà, rural / périurbain (rayon 300 m).
const URBAN_POPULATION_THRESHOLD = 10_000;
const URBAN_RADIUS_M = 100;
const RURAL_RADIUS_M = 300;
const HISTORY_YEARS = 6; // millésimes DVF balayés (≈ profondeur publiée)
const MIN_PPM2 = 500;
const MAX_PPM2 = 25_000;
const MIN_BUILT_SURFACE = 9;

const pageCache = new Map<string, { expiresAt: number; features: DvfFeature[] }>();
const communeCache = new Map<string, { expiresAt: number; value: CommuneInfo | null }>();

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

type ParcelSale = {
  parcelId: string;
  date: string;
  totalPrice: number;
  surface: number;
  pricePerM2: number;
  type: string;
  distanceM: number;
  isDwelling: boolean;
};

type CommuneInfo = { nom: string; population: number };

export type MarketAddressSale = {
  date: string;
  totalPrice: number;
  surface: number | null;
  pricePerM2: number | null;
  type: string;
};

export type MarketEstimate = {
  source: "DVF Cerema";
  radiusM: number;
  yearsBack: number;
  areaKind: "urban" | "rural";
  commune: string | null;
  sampleSize: number; // nombre de parcelles comparables retenues
  parcelSampleSize: number;
  totalNearbySampleSize: number;
  outliersRemoved: number;
  qualityScore: number;
  qualityLabel: "forte" | "correcte" | "fragile";
  qualityWarnings: string[];
  comparableMode: "surface_matched" | "nearby_type_only" | "address_history";
  surfaceMinM2: number | null;
  surfaceMaxM2: number | null;
  medianPricePerM2: number | null;
  p25PricePerM2: number | null;
  p75PricePerM2: number | null;
  minPricePerM2: number | null;
  maxPricePerM2: number | null;
  // Si on a un prix de référence (mise à prix, prix d'adjudication)
  deviationPct: number | null; // <0 = sous le marché, >0 = au-dessus
  // Les 5 dernières ventes de la parcelle du bien (historique exact).
  addressHistory: MarketAddressSale[];
  // Dernière vente de chaque parcelle du rayon (base de la fourchette).
  recentTransactions: Array<{
    date: string;
    pricePerM2: number;
    surface: number;
    totalPrice: number;
    type: string;
    distanceM: number | null;
  }>;
};

export type MarketContext = {
  ok: boolean;
  error: string | null;
  estimate: MarketEstimate | null;
};

const inputSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  // Override optionnel ; sinon le rayon est déduit du caractère urbain/rural.
  radiusM: z.number().min(50).max(2000).nullable().optional(),
  propertyType: z.string().nullable().optional(),
  pricePerM2Ref: z.number().nullable().optional(),
  surfaceM2: z.number().positive().nullable().optional(),
});

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

// ─── Statistiques ───────────────────────────────────────────────────────────

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
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
    const url = `${GEO_COMMUNES}?lat=${lat}&lon=${lng}&fields=nom,population&format=json`;
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": DVF_USER_AGENT },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) {
      const json = (await response.json()) as Array<{ nom?: string; population?: number }>;
      const first = Array.isArray(json) ? json[0] : null;
      if (first?.nom) {
        value = { nom: first.nom, population: Number(first.population) || 0 };
      }
    }
  } catch {
    value = null;
  }
  communeCache.set(key, { expiresAt: Date.now() + COMMUNE_CACHE_TTL_MS, value });
  return value;
}

async function fetchDvfYear(
  bbox: ReturnType<typeof bboxAround>,
  year: number,
): Promise<DvfFeature[]> {
  const url =
    `${CEREMA_BASE}?in_bbox=${bbox.xmin},${bbox.ymin},${bbox.xmax},${bbox.ymax}` +
    `&anneemut=${year}&page_size=500`;
  const cached = pageCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.features;

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
        return [];
      }
      const json = (await response.json()) as { features?: DvfFeature[] };
      const features = Array.isArray(json.features) ? json.features : [];
      pageCache.set(url, { expiresAt: Date.now() + PAGE_CACHE_TTL_MS, features });
      return features;
    } catch (err) {
      if (attempt === 2) {
        console.warn(
          `[dvf] millésime ${year} : ${err instanceof Error ? `${err.name} ${err.message}` : "échec réseau"}`,
        );
        return [];
      }
      await sleep(350 * (attempt + 1));
    }
  }
  return [];
}

// ─── Normalisation des mutations ────────────────────────────────────────────

function isDwellingType(codtypbien: string | undefined): boolean {
  // 111 = maison, 121 = appartement (codes Cerema "type de bien").
  return codtypbien === "111" || codtypbien === "121";
}

function parcelKey(props: DvfProps): string | null {
  const ids = Array.isArray(props.l_idpar) ? props.l_idpar.filter(Boolean) : [];
  if (ids.length === 0) return null;
  return [...ids].sort().join("+");
}

// ─── Analyse à un rayon donné ───────────────────────────────────────────────

type RadiusAnalysis = {
  perParcel: ParcelSale[];
  addressMutations: MarketAddressSale[];
  totalNearby: number;
};

async function analyzeAtRadius(lat: number, lng: number, radiusM: number): Promise<RadiusAnalysis> {
  const bbox = bboxAround(lat, lng, radiusM);
  const currentYear = new Date().getFullYear();
  const years: number[] = [];
  for (let y = currentYear; y > currentYear - HISTORY_YEARS; y -= 1) years.push(y);

  const batches = await Promise.allSettled(years.map((year) => fetchDvfYear(bbox, year)));
  const features = batches.flatMap((batch) => (batch.status === "fulfilled" ? batch.value : []));

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

  const sales: ParcelSale[] = [];
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
    const surface = parseFloat(props.sbati ?? "");
    const price = parseFloat(props.valeurfonc ?? "");
    const date = props.datemut ?? "";

    // Historique de l'adresse exacte : toute vente de la parcelle du bien.
    if (subjectKey && key === subjectKey && date) {
      const ppm2 =
        Number.isFinite(price) && Number.isFinite(surface) && surface >= 1
          ? Math.round(price / surface)
          : null;
      addressMutations.push({
        date,
        totalPrice: Number.isFinite(price) ? price : 0,
        surface: Number.isFinite(surface) && surface > 0 ? surface : null,
        pricePerM2: ppm2 && ppm2 >= MIN_PPM2 && ppm2 <= MAX_PPM2 ? ppm2 : null,
        type: props.libtypbien ?? "—",
      });
    }

    if (distanceM > radiusM) continue;
    totalNearby += 1;

    // Base parcellaire : on ne garde que les ventes bâties exploitables au m².
    if (!isDwellingType(props.codtypbien)) continue;
    if ((props.nblocmut ?? 1) > 1) continue; // mutations multi-logements : m² ambigu
    if (!Number.isFinite(price) || !Number.isFinite(surface)) continue;
    if (surface < MIN_BUILT_SURFACE || price < 10_000) continue;
    const pricePerM2 = price / surface;
    if (pricePerM2 < MIN_PPM2 || pricePerM2 > MAX_PPM2) continue;
    if (key === subjectKey) continue; // l'adresse est traitée à part

    sales.push({
      parcelId: key,
      date,
      totalPrice: price,
      surface,
      pricePerM2,
      type: props.libtypbien ?? "—",
      distanceM: Math.round(distanceM),
      isDwelling: true,
    });
  }

  // Une seule vente par parcelle : la plus récente.
  const latestByParcel = new Map<string, ParcelSale>();
  for (const sale of sales) {
    const existing = latestByParcel.get(sale.parcelId);
    if (!existing || sale.date > existing.date) latestByParcel.set(sale.parcelId, sale);
  }

  return { perParcel: [...latestByParcel.values()], addressMutations, totalNearby };
}

// ─── Cœur : estimation ──────────────────────────────────────────────────────

async function buildEstimate(input: {
  lat: number;
  lng: number;
  radiusOverride: number | null;
  propertyType: string | null | undefined;
  surfaceM2: number | null | undefined;
  pricePerM2Ref: number | null | undefined;
}): Promise<MarketEstimate> {
  const { lat, lng } = input;
  const commune = await fetchCommune(lat, lng);
  const areaKind: "urban" | "rural" =
    commune && commune.population >= URBAN_POPULATION_THRESHOLD ? "urban" : "rural";

  // On commence serré en ville, mais certaines communes périurbaines dépassent
  // le seuil de population sans offrir assez de mutations à 100 m.
  const radii = input.radiusOverride
    ? [input.radiusOverride]
    : areaKind === "urban"
      ? [URBAN_RADIUS_M, RURAL_RADIUS_M, 600, 1000]
      : [RURAL_RADIUS_M, 600, 1000];
  let analysis = await analyzeAtRadius(lat, lng, radii[0]);
  let radiusM = radii[0];
  for (let i = 1; i < radii.length && analysis.perParcel.length < 3; i += 1) {
    radiusM = radii[i];
    analysis = await analyzeAtRadius(lat, lng, radiusM);
  }
  const radiusWidened = !input.radiusOverride && radiusM > radii[0];

  const { perParcel, addressMutations, totalNearby } = analysis;

  // Optionnel : resserrer sur des surfaces comparables au bien.
  const subjectSurface =
    input.surfaceM2 != null &&
    Number.isFinite(input.surfaceM2) &&
    input.surfaceM2 >= MIN_BUILT_SURFACE
      ? input.surfaceM2
      : null;
  const surfaceMinM2 =
    subjectSurface == null ? null : Math.max(MIN_BUILT_SURFACE, subjectSurface * 0.55);
  const surfaceMaxM2 = subjectSurface == null ? null : subjectSurface * 1.8;
  const surfaceMatched =
    surfaceMinM2 == null || surfaceMaxM2 == null
      ? []
      : perParcel.filter((s) => s.surface >= surfaceMinM2 && s.surface <= surfaceMaxM2);
  let comparableMode: MarketEstimate["comparableMode"] =
    surfaceMatched.length >= 4 ? "surface_matched" : "nearby_type_only";

  const addressHistory = addressMutations.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  const addressPrices = addressHistory
    .map((sale) => sale.pricePerM2)
    .filter((value): value is number => value != null && value >= MIN_PPM2 && value <= MAX_PPM2);

  // Filtre des valeurs aberrantes (IQR) sur le prix au m².
  let basisPrices = (comparableMode === "surface_matched" ? surfaceMatched : perParcel).map(
    (s) => s.pricePerM2,
  );
  // ponytail: exact-address fallback; upgrade when DVF exposes enough parcel-level neighbours.
  if (basisPrices.length < 2 && addressPrices.length >= 2) {
    comparableMode = "address_history";
    basisPrices = addressPrices;
  }
  const outlierFiltered = removeOutliers(basisPrices);
  const ppm2Values = outlierFiltered.values;
  const sortedPpm2 = [...ppm2Values].sort((a, b) => a - b);

  const recentTransactions = [...perParcel]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 8)
    .map((s) => ({
      date: s.date,
      pricePerM2: Math.round(s.pricePerM2),
      surface: Math.round(s.surface),
      totalPrice: Math.round(s.totalPrice),
      type: s.type,
      distanceM: s.distanceM,
    }));

  const hasRange = sortedPpm2.length >= 2;
  const median = hasRange ? Math.round(percentile(sortedPpm2, 0.5)) : null;
  const p25 = hasRange ? Math.round(percentile(sortedPpm2, 0.25)) : null;
  const p75 = hasRange ? Math.round(percentile(sortedPpm2, 0.75)) : null;
  const minPpm2 = sortedPpm2.length ? Math.round(sortedPpm2[0]) : null;
  const maxPpm2 = sortedPpm2.length ? Math.round(sortedPpm2[sortedPpm2.length - 1]) : null;

  const quality = assessQuality({
    parcelCount: ppm2Values.length,
    areaKind,
    comparableMode,
    median,
    p25,
    p75,
    outliersRemoved: outlierFiltered.removed,
    addressCount: addressHistory.length,
  });
  if (radiusWidened) {
    quality.qualityWarnings = [
      `rayon élargi à ${radiusM} m faute de ventes proches`,
      ...quality.qualityWarnings,
    ];
  }

  const deviationPct =
    input.pricePerM2Ref != null && input.pricePerM2Ref > 0 && median
      ? ((input.pricePerM2Ref - median) / median) * 100
      : null;

  return {
    source: "DVF Cerema",
    radiusM,
    yearsBack: HISTORY_YEARS,
    areaKind,
    commune: commune?.nom ?? null,
    sampleSize: ppm2Values.length,
    parcelSampleSize: perParcel.length,
    totalNearbySampleSize: totalNearby,
    outliersRemoved: outlierFiltered.removed,
    ...quality,
    comparableMode,
    surfaceMinM2: surfaceMinM2 == null ? null : Math.round(surfaceMinM2),
    surfaceMaxM2: surfaceMaxM2 == null ? null : Math.round(surfaceMaxM2),
    medianPricePerM2: median,
    p25PricePerM2: p25,
    p75PricePerM2: p75,
    minPricePerM2: minPpm2,
    maxPricePerM2: maxPpm2,
    deviationPct,
    addressHistory,
    recentTransactions,
  };
}

function removeOutliers(values: number[]): { values: number[]; removed: number } {
  if (values.length < 7) return { values, removed: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const p25 = percentile(sorted, 0.25);
  const p75 = percentile(sorted, 0.75);
  const iqr = p75 - p25;
  if (iqr <= 0) return { values, removed: 0 };
  const lower = Math.max(MIN_PPM2, p25 - 1.5 * iqr);
  const upper = Math.min(MAX_PPM2, p75 + 1.5 * iqr);
  const filtered = values.filter((v) => v >= lower && v <= upper);
  return filtered.length >= 4
    ? { values: filtered, removed: values.length - filtered.length }
    : { values, removed: 0 };
}

function assessQuality({
  parcelCount,
  areaKind,
  comparableMode,
  median,
  p25,
  p75,
  outliersRemoved,
  addressCount,
}: {
  parcelCount: number;
  areaKind: "urban" | "rural";
  comparableMode: MarketEstimate["comparableMode"];
  median: number | null;
  p25: number | null;
  p75: number | null;
  outliersRemoved: number;
  addressCount: number;
}): Pick<MarketEstimate, "qualityScore" | "qualityLabel" | "qualityWarnings"> {
  const warnings: string[] = [];
  let score = 100;

  if (comparableMode === "address_history" && parcelCount < 3) {
    score -= 55;
    warnings.push("moins de 3 ventes historiques à l'adresse");
  } else if (parcelCount < 3) {
    score -= 55;
    warnings.push("moins de 3 parcelles comparables");
  } else if (parcelCount < 6) {
    score -= 24;
    warnings.push("échantillon parcellaire court");
  } else if (parcelCount < 10) {
    score -= 10;
  }

  if (comparableMode === "address_history") {
    score -= 16;
    warnings.push("historique de l'adresse utilisé faute de voisins exploitables");
  } else if (comparableMode !== "surface_matched") {
    score -= 12;
    warnings.push("surfaces non comparables");
  }

  if (median && p25 && p75) {
    const dispersion = (p75 - p25) / median;
    if (dispersion > 0.55) {
      score -= 16;
      warnings.push("prix locaux très dispersés");
    } else if (dispersion > 0.35) {
      score -= 8;
      warnings.push("prix locaux dispersés");
    }
  }

  if (outliersRemoved > 0) {
    score -= Math.min(8, outliersRemoved * 2);
    warnings.push(
      `${outliersRemoved} valeur${outliersRemoved > 1 ? "s" : ""} aberrante${
        outliersRemoved > 1 ? "s" : ""
      } ignorée${outliersRemoved > 1 ? "s" : ""}`,
    );
  }

  if (addressCount > 0) score = Math.min(100, score + 4);

  const qualityScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    qualityScore,
    qualityLabel: qualityScore >= 78 ? "forte" : qualityScore >= 58 ? "correcte" : "fragile",
    qualityWarnings: warnings,
  };
}

export const getMarketEstimate = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => inputSchema.parse(input))
  .handler(async ({ data }): Promise<MarketContext> => {
    try {
      const estimate = await buildEstimate({
        lat: data.lat,
        lng: data.lng,
        radiusOverride: data.radiusM ?? null,
        propertyType: data.propertyType,
        surfaceM2: data.surfaceM2,
        pricePerM2Ref: data.pricePerM2Ref,
      });
      // On ne fige pas 24 h un résultat vide/fragile (souvent un aléa réseau en
      // amont) : il doit pouvoir se recalculer vite. Cache long uniquement quand
      // l'échantillon est exploitable.
      const reliable = estimate.sampleSize >= 3;
      setResponseHeaders(
        new Headers({
          "cache-control": reliable
            ? "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800"
            : "public, max-age=300, s-maxage=300",
        }),
      );
      return { ok: true, error: null, estimate };
    } catch (err) {
      console.error("DVF fetch failed", err);
      setResponseHeaders(new Headers({ "cache-control": "public, max-age=60" }));
      return {
        ok: false,
        error: "Estimation de marché temporairement indisponible.",
        estimate: null,
      };
    }
  });
