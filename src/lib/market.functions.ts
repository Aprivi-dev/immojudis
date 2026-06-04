import { createServerFn } from "@tanstack/react-start";
import { setResponseHeaders } from "@tanstack/react-start/server";
import { z } from "zod";

// ─── DVF (Demandes de Valeurs Foncières) via API Cerema ─────────────────
// Données ouvertes DGFiP, toutes les transactions immobilières de France.
// https://apidf-preprod.cerema.fr/

const CEREMA_BASE = "https://apidf-preprod.cerema.fr/dvf_opendata/geomutations/";
const DVF_USER_AGENT = "immojudis/1.0 (+https://immojudis-dezt.vercel.app/contact)";
const DVF_PAGE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const dvfPageCache = new Map<string, { expiresAt: number; features: DvfFeature[] }>();

// Mapping property_type → codtypbien Cerema
function codtypbienFor(propertyType: string | null | undefined): string[] {
  if (!propertyType) return ["111", "121"];
  const s = propertyType.toLowerCase();
  if (s.includes("apart") || s.includes("apt") || s.includes("appartement")) return ["121"];
  if (s.includes("house") || s.includes("maison")) return ["111"];
  return ["111", "121"];
}

function bboxAround(lat: number, lng: number, radiusM: number) {
  const dLat = radiusM / 111_000;
  const dLng = radiusM / (111_000 * Math.cos((lat * Math.PI) / 180));
  return {
    xmin: lng - dLng,
    ymin: lat - dLat,
    xmax: lng + dLng,
    ymax: lat + dLat,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

type Mutation = {
  datemut: string;
  anneemut: number;
  valeurfonc: string;
  sbati: string;
  codtypbien: string;
  libtypbien: string;
};

type DvfComparable = {
  date: string;
  pricePerM2: number;
  surface: number;
  totalPrice: number;
  type: string;
  distanceM: number | null;
};

type DvfFeature = {
  properties: Mutation;
  geometry?: { coordinates?: unknown } | null;
};

type CandidateSelection = ReturnType<typeof selectComparables> & {
  enriched: DvfComparable[];
  radiusM: number;
  yearsBack: number;
};

export type MarketEstimate = {
  source: "DVF Cerema";
  radiusM: number;
  yearsBack: number;
  sampleSize: number;
  totalNearbySampleSize: number;
  outliersRemoved: number;
  qualityScore: number;
  qualityLabel: "forte" | "correcte" | "fragile";
  qualityWarnings: string[];
  comparableMode: "surface_matched" | "nearby_type_only";
  surfaceMinM2: number | null;
  surfaceMaxM2: number | null;
  medianPricePerM2: number | null;
  p25PricePerM2: number | null;
  p75PricePerM2: number | null;
  // Si on a un prix de référence (mise à prix, prix d'adjudication)
  deviationPct: number | null; // <0 = sous le marché, >0 = au-dessus
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
  radiusM: z.number().min(100).max(2000).default(500),
  yearsBack: z.number().min(1).max(5).default(2),
  propertyType: z.string().nullable().optional(),
  pricePerM2Ref: z.number().nullable().optional(), // pour calculer la déviation
  surfaceM2: z.number().positive().nullable().optional(),
});

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

async function fetchDvfComparables(
  lat: number,
  lng: number,
  radiusM: number,
  years: number[],
  codes: string[],
): Promise<DvfComparable[]> {
  const bbox = bboxAround(lat, lng, radiusM);
  const requests: Array<Promise<DvfFeature[]>> = [];
  for (const year of years) {
    for (const code of codes) {
      const url =
        `${CEREMA_BASE}?in_bbox=${bbox.xmin},${bbox.ymin},${bbox.xmax},${bbox.ymax}` +
        `&anneemut=${year}&codtypbien=${code}&page_size=500`;
      requests.push(fetchDvfPage(url));
    }
  }

  const batches = await Promise.allSettled(requests);
  const all = batches.flatMap((batch) => (batch.status === "fulfilled" ? batch.value : []));
  return all
    .map((feature) => {
      const mutation = feature.properties;
      const price = parseFloat(mutation.valeurfonc);
      const surface = parseFloat(mutation.sbati);
      if (!Number.isFinite(price) || !Number.isFinite(surface)) return null;
      if (surface < 10 || price < 10_000) return null;
      const pricePerM2 = price / surface;
      if (pricePerM2 < 500 || pricePerM2 > 25_000) return null;
      const distanceM = distanceFromFeature(lat, lng, feature.geometry?.coordinates);
      if (distanceM != null && distanceM > radiusM) return null;
      return {
        date: mutation.datemut,
        pricePerM2,
        surface,
        totalPrice: price,
        type: mutation.libtypbien,
        distanceM,
      };
    })
    .filter((item): item is DvfComparable => item !== null);
}

async function fetchDvfPage(url: string): Promise<DvfFeature[]> {
  const cached = dvfPageCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.features;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        cache: "force-cache",
        headers: {
          Accept: "application/json",
          "User-Agent": DVF_USER_AGENT,
        },
        signal: AbortSignal.timeout(12_000),
      });
      if (response.status === 429 || response.status >= 500) {
        await sleep(350 * (attempt + 1));
        continue;
      }
      if (!response.ok) return [];
      const json = (await response.json()) as { features?: DvfFeature[] };
      const features = Array.isArray(json.features) ? json.features : [];
      dvfPageCache.set(url, {
        expiresAt: Date.now() + DVF_PAGE_CACHE_TTL_MS,
        features,
      });
      return features;
    } catch {
      if (attempt === 2) return [];
      await sleep(350 * (attempt + 1));
    }
  }
  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function selectComparables(enriched: DvfComparable[], surfaceM2: number | null | undefined) {
  const subjectSurface =
    surfaceM2 != null && Number.isFinite(surfaceM2) && surfaceM2 >= 10 ? surfaceM2 : null;
  const surfaceMinM2 = subjectSurface == null ? null : Math.max(10, subjectSurface * 0.55);
  const surfaceMaxM2 = subjectSurface == null ? null : subjectSurface * 1.8;
  const surfaceMatched =
    surfaceMinM2 == null || surfaceMaxM2 == null
      ? []
      : enriched.filter((item) => item.surface >= surfaceMinM2 && item.surface <= surfaceMaxM2);
  const comparableMode = surfaceMatched.length >= 3 ? "surface_matched" : "nearby_type_only";
  return {
    comparables: comparableMode === "surface_matched" ? surfaceMatched : enriched,
    comparableMode,
    surfaceMinM2,
    surfaceMaxM2,
  };
}

function distanceFromFeature(lat: number, lng: number, coordinates: unknown): number | null {
  const pair = firstCoordinatePair(coordinates);
  if (!pair) return null;
  const [featureLng, featureLat] = pair;
  return Math.round(haversineMeters(lat, lng, featureLat, featureLng));
}

function firstCoordinatePair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const [first, second] = value;
  if (typeof first === "number" && typeof second === "number") {
    if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
    return [first, second];
  }
  for (const item of value) {
    const pair = firstCoordinatePair(item);
    if (pair) return pair;
  }
  return null;
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

function removeOutliers(comparables: DvfComparable[]): {
  comparables: DvfComparable[];
  outliersRemoved: number;
} {
  if (comparables.length < 7) return { comparables, outliersRemoved: 0 };
  const sorted = comparables.map((item) => item.pricePerM2).sort((a, b) => a - b);
  const p25 = percentile(sorted, 0.25);
  const p75 = percentile(sorted, 0.75);
  const iqr = p75 - p25;
  if (iqr <= 0) return { comparables, outliersRemoved: 0 };
  const lower = Math.max(500, p25 - 1.5 * iqr);
  const upper = Math.min(25_000, p75 + 1.5 * iqr);
  const filtered = comparables.filter(
    (item) => item.pricePerM2 >= lower && item.pricePerM2 <= upper,
  );
  return {
    comparables: filtered.length >= 3 ? filtered : comparables,
    outliersRemoved: filtered.length >= 3 ? comparables.length - filtered.length : 0,
  };
}

async function findBestComparables({
  lat,
  lng,
  initialRadiusM,
  yearsBack,
  propertyType,
  surfaceM2,
}: {
  lat: number;
  lng: number;
  initialRadiusM: number;
  yearsBack: number;
  propertyType: string | null | undefined;
  surfaceM2: number | null | undefined;
}): Promise<CandidateSelection> {
  const codes = codtypbienFor(propertyType);
  const currentYear = new Date().getFullYear();
  const radii = [...new Set([initialRadiusM, 750, 1_000, 1_500, 2_000])].filter(
    (radius) => radius >= initialRadiusM && radius <= 2_000,
  );
  const yearsBackOptions = [...new Set([yearsBack, 3, 5])].filter((value) => value >= yearsBack);
  let best: CandidateSelection | null = null;

  for (const optionYearsBack of yearsBackOptions) {
    const years: number[] = [];
    for (let year = currentYear - optionYearsBack; year <= currentYear; year += 1) {
      years.push(year);
    }

    for (const radiusM of radii) {
      const enriched = await fetchDvfComparables(lat, lng, radiusM, years, codes);
      const selected = selectComparables(enriched, surfaceM2);
      const candidate: CandidateSelection = {
        ...selected,
        enriched,
        radiusM,
        yearsBack: optionYearsBack,
      };

      if (!best || candidateRank(candidate) > candidateRank(best)) {
        best = candidate;
      }

      if (selected.comparableMode === "surface_matched" && selected.comparables.length >= 3) {
        return candidate;
      }

      if (
        selected.comparableMode === "nearby_type_only" &&
        selected.comparables.length >= 6 &&
        radiusM <= 1_500
      ) {
        return candidate;
      }
    }
  }

  return (
    best ?? {
      comparables: [],
      comparableMode: "nearby_type_only",
      surfaceMinM2: null,
      surfaceMaxM2: null,
      enriched: [],
      radiusM: initialRadiusM,
      yearsBack,
    }
  );
}

function candidateRank(candidate: CandidateSelection): number {
  const comparableBonus = Math.min(candidate.comparables.length, 20) * 10;
  const surfaceBonus = candidate.comparableMode === "surface_matched" ? 120 : 0;
  const nearbyBonus = Math.min(candidate.enriched.length, 30);
  const radiusPenalty = candidate.radiusM / 100;
  const yearsPenalty = Math.max(0, candidate.yearsBack - 2) * 4;
  return surfaceBonus + comparableBonus + nearbyBonus - radiusPenalty - yearsPenalty;
}

function marketQuality({
  sampleSize,
  radiusM,
  comparableMode,
  medianPricePerM2,
  p25PricePerM2,
  p75PricePerM2,
  outliersRemoved,
}: {
  sampleSize: number;
  radiusM: number;
  comparableMode: MarketEstimate["comparableMode"];
  medianPricePerM2: number | null;
  p25PricePerM2: number | null;
  p75PricePerM2: number | null;
  outliersRemoved: number;
}): Pick<MarketEstimate, "qualityScore" | "qualityLabel" | "qualityWarnings"> {
  const warnings: string[] = [];
  let score = 100;

  if (sampleSize < 3) {
    score -= 55;
    warnings.push("moins de 3 ventes comparables");
  } else if (sampleSize < 6) {
    score -= 22;
    warnings.push("échantillon court");
  } else if (sampleSize < 10) {
    score -= 10;
  }

  if (radiusM > 500) {
    score -= radiusM >= 1500 ? 18 : 10;
    warnings.push(`rayon élargi à ${radiusM} m`);
  }

  if (comparableMode !== "surface_matched") {
    score -= 14;
    warnings.push("surface non comparable");
  }

  if (medianPricePerM2 && p25PricePerM2 && p75PricePerM2) {
    const dispersion = (p75PricePerM2 - p25PricePerM2) / medianPricePerM2;
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
      `${outliersRemoved} valeur${outliersRemoved > 1 ? "s" : ""} aberrante${outliersRemoved > 1 ? "s" : ""} ignorée${outliersRemoved > 1 ? "s" : ""}`,
    );
  }

  const qualityScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    qualityScore,
    qualityLabel: qualityScore >= 78 ? "forte" : qualityScore >= 58 ? "correcte" : "fragile",
    qualityWarnings: warnings,
  };
}

function withSearchWarnings(
  quality: Pick<MarketEstimate, "qualityScore" | "qualityLabel" | "qualityWarnings">,
  requestedYearsBack: number,
  effectiveYearsBack: number,
): Pick<MarketEstimate, "qualityScore" | "qualityLabel" | "qualityWarnings"> {
  if (effectiveYearsBack <= requestedYearsBack) return quality;
  return {
    ...quality,
    qualityWarnings: [...quality.qualityWarnings, `période élargie à ${effectiveYearsBack} ans`],
  };
}

export const getMarketEstimate = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => inputSchema.parse(input))
  .handler(async ({ data }): Promise<MarketContext> => {
    // Cache CDN 24h (les données DVF changent au mieux trimestriellement)
    setResponseHeaders(
      new Headers({ "cache-control": "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800" }),
    );

    try {
      const selected = await findBestComparables({
        lat: data.lat,
        lng: data.lng,
        initialRadiusM: data.radiusM,
        yearsBack: data.yearsBack,
        propertyType: data.propertyType,
        surfaceM2: data.surfaceM2,
      });

      const { comparableMode, surfaceMinM2, surfaceMaxM2, radiusM, yearsBack, enriched } = selected;
      const outlierFiltered = removeOutliers(selected.comparables);
      const comparables = outlierFiltered.comparables;

      if (comparables.length < 2) {
        const quality = marketQuality({
          sampleSize: comparables.length,
          radiusM,
          comparableMode,
          medianPricePerM2: null,
          p25PricePerM2: null,
          p75PricePerM2: null,
          outliersRemoved: outlierFiltered.outliersRemoved,
        });
        return {
          ok: true,
          error: null,
          estimate: {
            source: "DVF Cerema",
            radiusM,
            yearsBack,
            sampleSize: comparables.length,
            totalNearbySampleSize: enriched.length,
            outliersRemoved: outlierFiltered.outliersRemoved,
            ...withSearchWarnings(quality, data.yearsBack, yearsBack),
            comparableMode,
            surfaceMinM2: surfaceMinM2 == null ? null : Math.round(surfaceMinM2),
            surfaceMaxM2: surfaceMaxM2 == null ? null : Math.round(surfaceMaxM2),
            medianPricePerM2: null,
            p25PricePerM2: null,
            p75PricePerM2: null,
            deviationPct: null,
            recentTransactions: comparables.slice(0, 5),
          },
        };
      }

      const sortedPpm2 = comparables.map((e) => e.pricePerM2).sort((a, b) => a - b);
      const med = median(sortedPpm2);
      const p25 = percentile(sortedPpm2, 0.25);
      const p75 = percentile(sortedPpm2, 0.75);
      const roundedMedian = Math.round(med);
      const roundedP25 = Math.round(p25);
      const roundedP75 = Math.round(p75);
      const quality = marketQuality({
        sampleSize: comparables.length,
        radiusM,
        comparableMode,
        medianPricePerM2: roundedMedian,
        p25PricePerM2: roundedP25,
        p75PricePerM2: roundedP75,
        outliersRemoved: outlierFiltered.outliersRemoved,
      });

      const deviationPct =
        data.pricePerM2Ref != null && data.pricePerM2Ref > 0
          ? ((data.pricePerM2Ref - med) / med) * 100
          : null;

      // 5 transactions les plus récentes pour transparence
      const recent = [...comparables].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);

      return {
        ok: true,
        error: null,
        estimate: {
          source: "DVF Cerema",
          radiusM,
          yearsBack,
          sampleSize: comparables.length,
          totalNearbySampleSize: enriched.length,
          outliersRemoved: outlierFiltered.outliersRemoved,
          ...withSearchWarnings(quality, data.yearsBack, yearsBack),
          comparableMode,
          surfaceMinM2: surfaceMinM2 == null ? null : Math.round(surfaceMinM2),
          surfaceMaxM2: surfaceMaxM2 == null ? null : Math.round(surfaceMaxM2),
          medianPricePerM2: roundedMedian,
          p25PricePerM2: roundedP25,
          p75PricePerM2: roundedP75,
          deviationPct,
          recentTransactions: recent,
        },
      };
    } catch (err) {
      console.error("DVF fetch failed", err);
      return {
        ok: false,
        error: "Estimation de marché temporairement indisponible.",
        estimate: null,
      };
    }
  });
