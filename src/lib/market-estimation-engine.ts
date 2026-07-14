import { gridDistance, latLngToCell } from "h3-js";

export type MarketPropertySegment =
  | "apartment"
  | "house"
  | "building"
  | "commercial"
  | "land"
  | "unsupported";

export type MarketComparableMode =
  | "surface_land_matched"
  | "surface_matched"
  | "land_matched"
  | "same_type_expanded";

export type MarketEngineCandidate = {
  id: string;
  parcelId: string;
  date: string;
  totalPrice: number;
  builtSurfaceM2: number | null;
  landSurfaceM2: number | null;
  pricePerM2: number;
  propertyType: string;
  segment: Exclude<MarketPropertySegment, "unsupported">;
  distanceM: number;
  latitude?: number | null;
  longitude?: number | null;
};

export type ScoredMarketComparable = MarketEngineCandidate & {
  primarySurfaceM2: number;
  monthsOld: number;
  observedPricePerM2: number;
  adjustedPricePerM2: number;
  timeAdjustmentFactor: number;
  marketCell: string | null;
  weight: number;
  score: number;
  scoreBreakdown: {
    distance: number;
    recency: number;
    surface: number;
    land: number | null;
    microMarket: number | null;
  };
};

export type MarketPredictionInterval = {
  coverageTarget: 0.8;
  method: "local_jackknife" | "segment_fallback";
  p10PricePerM2: number;
  p50PricePerM2: number;
  p90PricePerM2: number;
  conformalExpansionPct: number;
};

export type MarketEngineResult = {
  mode: MarketComparableMode;
  sampleSize: number;
  effectiveSampleSize: number;
  outliersRemoved: number;
  actionable: boolean;
  medianPricePerM2: number;
  p10PricePerM2: number;
  p25PricePerM2: number;
  p75PricePerM2: number;
  p90PricePerM2: number;
  minPricePerM2: number;
  maxPricePerM2: number;
  primarySurfaceMinM2: number | null;
  primarySurfaceMaxM2: number | null;
  landSurfaceMinM2: number | null;
  landSurfaceMaxM2: number | null;
  annualMarketTrendPct: number;
  marketCell: string | null;
  predictionInterval: MarketPredictionInterval;
  comparables: ScoredMarketComparable[];
  warnings: string[];
};

const MIN_ACTIONABLE_SAMPLE = 4;
const MAX_COMPARABLES = 18;
const TARGET_INTERVAL_COVERAGE = 0.8 as const;

const SEGMENT_FALLBACK_LOG_ERROR: Record<Exclude<MarketPropertySegment, "unsupported">, number> = {
  apartment: Math.log(1.16),
  house: Math.log(1.2),
  building: Math.log(1.25),
  commercial: Math.log(1.28),
  land: Math.log(1.3),
};

export function resolveMarketPropertySegment(input: {
  propertyType?: string | null;
  surfaceKind?: string | null;
  surfaceScope?: string | null;
}): MarketPropertySegment {
  const type = (input.propertyType ?? "").toLowerCase();
  const surfaceKind = (input.surfaceKind ?? "").toLowerCase();
  const surfaceScope = (input.surfaceScope ?? "").toLowerCase();
  if (surfaceKind === "land" || surfaceScope === "land" || /terrain|\bland\b|parcelle/.test(type)) {
    return "land";
  }
  if (/appartement|apartment|studio|\bapt\b|\bt[1-9]\b/.test(type)) return "apartment";
  if (/maison|house|villa|pavillon/.test(type)) return "house";
  if (/immeuble|building/.test(type)) return "building";
  if (/commerce|commercial|local d'activit|local professionnel|bureau|retail/.test(type)) {
    return "commercial";
  }
  if (/\b(mixed|mixte)\b/.test(type)) return "building";
  return "unsupported";
}

export function mutationSegmentFromCode(
  code: string | null | undefined,
): Exclude<MarketPropertySegment, "unsupported"> | null {
  if (code === "121") return "apartment";
  if (code === "111") return "house";
  if (code === "112" || code === "122" || code === "123" || code === "151") return "building";
  if (code && (/^14/.test(code) || code === "152")) return "commercial";
  if (code && /^2/.test(code)) return "land";
  return null;
}

export function primarySurfaceForSegment(
  segment: Exclude<MarketPropertySegment, "unsupported">,
  candidate: Pick<MarketEngineCandidate, "builtSurfaceM2" | "landSurfaceM2">,
): number | null {
  return segment === "land"
    ? positive(candidate.landSurfaceM2)
    : positive(candidate.builtSurfaceM2);
}

export function analyzeMarketCandidates(input: {
  segment: Exclude<MarketPropertySegment, "unsupported">;
  subjectBuiltSurfaceM2: number | null;
  subjectLandSurfaceM2: number | null;
  subjectLatitude?: number | null;
  subjectLongitude?: number | null;
  candidates: MarketEngineCandidate[];
  now?: Date;
  maxAgeMonths?: number;
}): MarketEngineResult | null {
  const now = input.now ?? new Date();
  const maxAgeMonths = input.maxAgeMonths ?? 60;
  const subjectPrimarySurface =
    input.segment === "land"
      ? positive(input.subjectLandSurfaceM2)
      : positive(input.subjectBuiltSurfaceM2);
  if (!subjectPrimarySurface) return null;

  const primaryTolerance =
    input.segment === "apartment"
      ? 0.35
      : input.segment === "house"
        ? 0.4
        : input.segment === "land"
          ? 0.6
          : 0.5;
  const primaryWindow = surfaceWindow(subjectPrimarySurface, primaryTolerance, 1);
  const subjectLandSurface =
    input.segment === "house" ? positive(input.subjectLandSurfaceM2) : null;
  const landWindow = subjectLandSurface ? surfaceWindow(subjectLandSurface, 0.65, 1) : null;

  const normalized = dedupeCandidates(input.candidates)
    .filter((candidate) => candidate.segment === input.segment)
    .map((candidate) => {
      const primarySurfaceM2 = primarySurfaceForSegment(input.segment, candidate);
      const saleDate = parseDate(candidate.date);
      if (!primarySurfaceM2 || !saleDate || !validPricePerM2(candidate.pricePerM2, input.segment)) {
        return null;
      }
      const monthsOld = monthDistance(saleDate, now);
      if (monthsOld < 0 || monthsOld > maxAgeMonths) return null;
      return { candidate, primarySurfaceM2, monthsOld };
    })
    .filter(
      (
        value,
      ): value is {
        candidate: MarketEngineCandidate;
        primarySurfaceM2: number;
        monthsOld: number;
      } => value != null,
    );
  if (!normalized.length) return null;

  const subjectMarketCell = marketCellForCoordinates(
    input.subjectLatitude,
    input.subjectLongitude,
    input.segment,
  );
  const annualMarketTrend = estimateAnnualMarketTrend(normalized);

  const primaryMatched = normalized.filter((value) =>
    inWindow(value.primarySurfaceM2, primaryWindow),
  );
  const primaryAndLandMatched =
    input.segment === "house" && landWindow
      ? primaryMatched.filter((value) => {
          const landSurface = positive(value.candidate.landSurfaceM2);
          return landSurface != null && inWindow(landSurface, landWindow);
        })
      : [];

  let mode: MarketComparableMode;
  let selected = normalized;
  if (primaryAndLandMatched.length >= MIN_ACTIONABLE_SAMPLE) {
    mode = "surface_land_matched";
    selected = primaryAndLandMatched;
  } else if (primaryMatched.length >= MIN_ACTIONABLE_SAMPLE) {
    mode = input.segment === "land" ? "land_matched" : "surface_matched";
    selected = primaryMatched;
  } else {
    mode = "same_type_expanded";
  }

  const outlierFiltered = removePriceOutliers(selected);
  const scored = outlierFiltered.values
    .map((value) =>
      scoreCandidate({
        ...value,
        segment: input.segment,
        subjectPrimarySurface,
        subjectLandSurface,
        subjectMarketCell,
        annualMarketTrend,
        maxDistanceM: Math.max(...selected.map((item) => item.candidate.distanceM), 300),
        maxAgeMonths,
      }),
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_COMPARABLES);
  if (!scored.length) return null;

  const weighted = scored.map((candidate) => ({
    value: candidate.adjustedPricePerM2,
    weight: candidate.weight,
  }));
  const median = Math.round(weightedQuantile(weighted, 0.5));
  const empiricalP10 = Math.round(weightedQuantile(weighted, 0.1));
  const empiricalP90 = Math.round(weightedQuantile(weighted, 0.9));
  let p25 = Math.round(weightedQuantile(weighted, 0.25));
  let p75 = Math.round(weightedQuantile(weighted, 0.75));
  const minimumSpread = scored.length >= 10 ? 0.08 : scored.length >= 6 ? 0.12 : 0.2;
  p25 = Math.min(p25, Math.round(median * (1 - minimumSpread)));
  p75 = Math.max(p75, Math.round(median * (1 + minimumSpread)));
  const predictionInterval = conformalPredictionInterval({
    segment: input.segment,
    median,
    empiricalP10,
    empiricalP90,
    comparables: scored,
  });
  const effectiveSampleSize = effectiveSample(scored.map((candidate) => candidate.weight));
  const dispersion = median > 0 ? (p75 - p25) / median : 1;
  const actionable =
    scored.length >= MIN_ACTIONABLE_SAMPLE &&
    effectiveSampleSize >= 3 &&
    dispersion <= 0.75 &&
    mode !== "same_type_expanded";
  const warnings: string[] = [];
  if (scored.length < MIN_ACTIONABLE_SAMPLE) warnings.push("échantillon inférieur à 4 ventes");
  if (effectiveSampleSize < 3) warnings.push("échantillon effectif trop concentré");
  if (mode === "same_type_expanded") warnings.push("surfaces élargies dans le même type de bien");
  if (input.segment === "house" && subjectLandSurface && mode !== "surface_land_matched") {
    warnings.push("terrains comparables insuffisants");
  }
  if (dispersion > 0.5) warnings.push("forte dispersion des prix pondérés");
  if (outlierFiltered.removed > 0) {
    warnings.push(`${outlierFiltered.removed} valeur(s) extrême(s) écartée(s)`);
  }

  const prices = scored.map((candidate) => candidate.adjustedPricePerM2).sort((a, b) => a - b);
  return {
    mode,
    sampleSize: scored.length,
    effectiveSampleSize: round(effectiveSampleSize, 1),
    outliersRemoved: outlierFiltered.removed,
    actionable,
    medianPricePerM2: median,
    p10PricePerM2: predictionInterval.p10PricePerM2,
    p25PricePerM2: p25,
    p75PricePerM2: p75,
    p90PricePerM2: predictionInterval.p90PricePerM2,
    minPricePerM2: Math.round(prices[0]),
    maxPricePerM2: Math.round(prices[prices.length - 1]),
    primarySurfaceMinM2: Math.round(primaryWindow.min),
    primarySurfaceMaxM2: Math.round(primaryWindow.max),
    landSurfaceMinM2: landWindow ? Math.round(landWindow.min) : null,
    landSurfaceMaxM2: landWindow ? Math.round(landWindow.max) : null,
    annualMarketTrendPct: round(annualMarketTrend * 100, 1),
    marketCell: subjectMarketCell,
    predictionInterval,
    comparables: scored,
    warnings,
  };
}

function scoreCandidate(input: {
  candidate: MarketEngineCandidate;
  primarySurfaceM2: number;
  monthsOld: number;
  segment: Exclude<MarketPropertySegment, "unsupported">;
  subjectPrimarySurface: number;
  subjectLandSurface: number | null;
  subjectMarketCell: string | null;
  annualMarketTrend: number;
  maxDistanceM: number;
  maxAgeMonths: number;
}): ScoredMarketComparable {
  const distance = Math.exp(-input.candidate.distanceM / Math.max(300, input.maxDistanceM * 0.55));
  const recency = Math.exp((-Math.log(2) * input.monthsOld) / 24);
  const surface = similarityRatio(input.primarySurfaceM2, input.subjectPrimarySurface);
  const candidateLand = positive(input.candidate.landSurfaceM2);
  const land =
    input.segment === "house" && input.subjectLandSurface
      ? candidateLand
        ? similarityRatio(candidateLand, input.subjectLandSurface)
        : 0.35
      : null;
  const candidateMarketCell = marketCellForCoordinates(
    input.candidate.latitude,
    input.candidate.longitude,
    input.segment,
  );
  const microMarket = marketCellSimilarity(input.subjectMarketCell, candidateMarketCell);
  const score01 =
    input.segment === "house" && land != null
      ? distance * 0.25 +
        recency * 0.2 +
        surface * 0.25 +
        land * 0.15 +
        (microMarket ?? distance) * 0.15
      : distance * 0.3 + recency * 0.22 + surface * 0.3 + (microMarket ?? distance) * 0.18;
  const weight = Math.max(0.05, score01 ** 2);
  const timeAdjustmentFactor = Math.pow(1 + input.annualMarketTrend, input.monthsOld / 12);
  const adjustedPricePerM2 = input.candidate.pricePerM2 * timeAdjustmentFactor;
  return {
    ...input.candidate,
    primarySurfaceM2: input.primarySurfaceM2,
    monthsOld: round(input.monthsOld, 1),
    observedPricePerM2: Math.round(input.candidate.pricePerM2),
    adjustedPricePerM2: Math.round(adjustedPricePerM2),
    timeAdjustmentFactor: round(timeAdjustmentFactor, 4),
    marketCell: candidateMarketCell,
    weight: round(weight, 4),
    score: Math.round(score01 * 100),
    scoreBreakdown: {
      distance: Math.round(distance * 100),
      recency: Math.round(recency * 100),
      surface: Math.round(surface * 100),
      land: land == null ? null : Math.round(land * 100),
      microMarket: microMarket == null ? null : Math.round(microMarket * 100),
    },
  };
}

function estimateAnnualMarketTrend(
  values: Array<{
    candidate: MarketEngineCandidate;
    monthsOld: number;
  }>,
): number {
  if (values.length < 6) return 0;
  const spanMonths = Math.max(...values.map((value) => value.monthsOld));
  if (spanMonths < 12) return 0;

  const logs = values.map((value) => Math.log(value.candidate.pricePerM2)).sort((a, b) => a - b);
  const lower = percentile(logs, 0.1);
  const upper = percentile(logs, 0.9);
  const rows = values.map((value) => ({
    x: -value.monthsOld / 12,
    y: Math.max(lower, Math.min(upper, Math.log(value.candidate.pricePerM2))),
    weight: Math.exp(-value.candidate.distanceM / 1_500),
  }));
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  const meanX = rows.reduce((sum, row) => sum + row.x * row.weight, 0) / totalWeight;
  const meanY = rows.reduce((sum, row) => sum + row.y * row.weight, 0) / totalWeight;
  const covariance = rows.reduce(
    (sum, row) => sum + row.weight * (row.x - meanX) * (row.y - meanY),
    0,
  );
  const variance = rows.reduce((sum, row) => sum + row.weight * (row.x - meanX) ** 2, 0);
  if (variance <= 1e-9) return 0;

  const rawAnnualTrend = Math.exp(covariance / variance) - 1;
  const shrinkage = Math.min(0.8, values.length / (values.length + 12));
  return Math.max(-0.12, Math.min(0.12, rawAnnualTrend * shrinkage));
}

function conformalPredictionInterval(input: {
  segment: Exclude<MarketPropertySegment, "unsupported">;
  median: number;
  empiricalP10: number;
  empiricalP90: number;
  comparables: ScoredMarketComparable[];
}): MarketPredictionInterval {
  const residuals = input.comparables
    .map((comparable, index) => {
      const remaining = input.comparables.filter((_, otherIndex) => otherIndex !== index);
      if (remaining.length < 3) return null;
      const prediction = weightedQuantile(
        remaining.map((item) => ({ value: item.adjustedPricePerM2, weight: item.weight })),
        0.5,
      );
      return prediction > 0 ? Math.abs(Math.log(comparable.adjustedPricePerM2 / prediction)) : null;
    })
    .filter((value): value is number => value != null && Number.isFinite(value))
    .sort((a, b) => a - b);
  const method = residuals.length >= 6 ? "local_jackknife" : "segment_fallback";
  const logExpansion =
    method === "local_jackknife"
      ? Math.max(percentile(residuals, TARGET_INTERVAL_COVERAGE), Math.log(1.08))
      : SEGMENT_FALLBACK_LOG_ERROR[input.segment];
  const lowerFromResidual = input.median / Math.exp(logExpansion);
  const upperFromResidual = input.median * Math.exp(logExpansion);
  const p10 = Math.round(Math.min(input.empiricalP10, lowerFromResidual));
  const p90 = Math.round(Math.max(input.empiricalP90, upperFromResidual));

  return {
    coverageTarget: TARGET_INTERVAL_COVERAGE,
    method,
    p10PricePerM2: Math.min(p10, input.median),
    p50PricePerM2: input.median,
    p90PricePerM2: Math.max(p90, input.median),
    conformalExpansionPct: round((Math.exp(logExpansion) - 1) * 100, 1),
  };
}

function marketCellForCoordinates(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
  segment: Exclude<MarketPropertySegment, "unsupported">,
): string | null {
  if (
    latitude == null ||
    longitude == null ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    return null;
  }
  const resolution = segment === "land" ? 7 : segment === "house" ? 8 : 9;
  try {
    return latLngToCell(latitude, longitude, resolution);
  } catch {
    return null;
  }
}

function marketCellSimilarity(
  subjectCell: string | null,
  candidateCell: string | null,
): number | null {
  if (!subjectCell || !candidateCell) return null;
  try {
    const distance = gridDistance(subjectCell, candidateCell);
    if (distance === 0) return 1;
    if (distance === 1) return 0.82;
    if (distance === 2) return 0.58;
    if (distance === 3) return 0.38;
    return 0.2;
  } catch {
    return null;
  }
}

function dedupeCandidates(candidates: MarketEngineCandidate[]): MarketEngineCandidate[] {
  const byMutation = new Map<string, MarketEngineCandidate>();
  for (const candidate of candidates) {
    const key = candidate.id || `${candidate.parcelId}:${candidate.date}`;
    const current = byMutation.get(key);
    if (!current || candidate.distanceM < current.distanceM) byMutation.set(key, candidate);
  }
  return [...byMutation.values()];
}

function removePriceOutliers<T extends { candidate: MarketEngineCandidate }>(
  values: T[],
): {
  values: T[];
  removed: number;
} {
  if (values.length < 7) return { values, removed: 0 };
  const prices = values.map((value) => value.candidate.pricePerM2).sort((a, b) => a - b);
  const p25 = percentile(prices, 0.25);
  const p75 = percentile(prices, 0.75);
  const iqr = p75 - p25;
  if (iqr <= 0) return { values, removed: 0 };
  const lower = p25 - 1.5 * iqr;
  const upper = p75 + 1.5 * iqr;
  const filtered = values.filter(
    (value) => value.candidate.pricePerM2 >= lower && value.candidate.pricePerM2 <= upper,
  );
  return filtered.length >= MIN_ACTIONABLE_SAMPLE
    ? { values: filtered, removed: values.length - filtered.length }
    : { values, removed: 0 };
}

function validPricePerM2(
  value: number,
  segment: Exclude<MarketPropertySegment, "unsupported">,
): boolean {
  if (!Number.isFinite(value) || value <= 0) return false;
  return segment === "land" ? value >= 1 && value <= 100_000 : value >= 300 && value <= 50_000;
}

function weightedQuantile(values: Array<{ value: number; weight: number }>, p: number): number {
  const sorted = [...values].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, item) => sum + item.weight, 0);
  const threshold = total * p;
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative >= threshold) return item.value;
  }
  return sorted.at(-1)?.value ?? 0;
}

function effectiveSample(weights: number[]): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const squared = weights.reduce((sum, weight) => sum + weight ** 2, 0);
  return squared > 0 ? total ** 2 / squared : 0;
}

function similarityRatio(value: number, reference: number): number {
  return Math.exp(-Math.abs(Math.log(value / reference)) / 0.55);
}

function surfaceWindow(value: number, tolerance: number, minimum: number) {
  return { min: Math.max(minimum, value * (1 - tolerance)), max: value * (1 + tolerance) };
}

function inWindow(value: number, window: { min: number; max: number }): boolean {
  return value >= window.min && value <= window.max;
}

function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function monthDistance(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24 * 30.4375);
}

function percentile(sortedAsc: number[], p: number): number {
  const index = (sortedAsc.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedAsc[lower];
  return sortedAsc[lower] + (sortedAsc[upper] - sortedAsc[lower]) * (index - lower);
}

function positive(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
