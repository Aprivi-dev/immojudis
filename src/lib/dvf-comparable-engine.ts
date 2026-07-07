export type DvfComparableCandidate = {
  id: string;
  saleDate: string;
  totalPriceEur: number | null;
  surfaceM2: number | null;
  pricePerM2?: number | null;
  propertyType: string | null;
  distanceM?: number | null;
  address?: string | null;
  city?: string | null;
  postalCode?: string | null;
  parcelId?: string | null;
  source?: string | null;
  sourceUrl?: string | null;
};

export type DvfComparableSubject = {
  surfaceM2: number | null;
  propertyType: string | null;
  startingPriceEur?: number | null;
};

export type DvfComparableMode = "surface_matched" | "nearby_type_only" | "expanded_fallback";

export type ScoredDvfComparable = DvfComparableCandidate & {
  pricePerM2: number;
  monthsOld: number;
  surfaceDeltaPct: number | null;
  typeMatch: boolean;
  score: number;
  scoreBreakdown: {
    distance: number;
    recency: number;
    surface: number;
    type: number;
  };
  reasons: string[];
};

export type DvfComparableAnalysis = {
  available: boolean;
  status: "detailed" | "usable" | "weak" | "missing";
  comparableMode: DvfComparableMode | null;
  sampleSize: number;
  totalCandidateCount: number;
  excludedCandidateCount: number;
  outliersRemoved: number;
  radiusM: number | null;
  maxAgeMonths: number;
  surfaceWindow: {
    minM2: number | null;
    maxM2: number | null;
    tolerancePct: number | null;
  };
  confidenceScore: number;
  confidenceLabel: "forte" | "correcte" | "fragile" | "indisponible";
  medianPricePerM2: number | null;
  weightedAveragePricePerM2: number | null;
  p25PricePerM2: number | null;
  p75PricePerM2: number | null;
  lowValueEur: number | null;
  medianValueEur: number | null;
  highValueEur: number | null;
  apparentDiscountPct: number | null;
  comparables: ScoredDvfComparable[];
  warnings: string[];
  summary: string;
  nextActions: string[];
  limitations: string[];
};

type BuildDvfComparableAnalysisInput = {
  subject: DvfComparableSubject;
  candidates: DvfComparableCandidate[];
  options?: {
    now?: Date;
    minSampleSize?: number;
    maxRadiusM?: number;
    maxAgeMonths?: number;
    surfaceTolerancePct?: number;
    limit?: number;
  };
};

type ComparableScope = {
  radiusM: number;
  mode: DvfComparableMode;
  candidates: NormalizedComparable[];
};

type NormalizedComparable = Omit<DvfComparableCandidate, "pricePerM2" | "surfaceM2"> & {
  pricePerM2: number;
  surfaceM2: number;
  monthsOld: number;
  surfaceDeltaPct: number | null;
  typeMatch: boolean;
};

const DEFAULT_MAX_AGE_MONTHS = 36;
const DEFAULT_MAX_RADIUS_M = 2_000;
const DEFAULT_MIN_SAMPLE_SIZE = 4;
const DEFAULT_SURFACE_TOLERANCE_PCT = 30;
const DEFAULT_LIMIT = 12;
const MIN_PRICE_PER_M2 = 500;
const MAX_PRICE_PER_M2 = 25_000;
const MIN_SURFACE_M2 = 9;
const RADIUS_STEPS_M = [300, 600, 1_000, 2_000];

export function buildDvfComparableAnalysis({
  subject,
  candidates,
  options = {},
}: BuildDvfComparableAnalysisInput): DvfComparableAnalysis {
  const now = options.now ?? new Date();
  const maxAgeMonths = options.maxAgeMonths ?? DEFAULT_MAX_AGE_MONTHS;
  const maxRadiusM = options.maxRadiusM ?? DEFAULT_MAX_RADIUS_M;
  const minSampleSize = options.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE;
  const surfaceTolerancePct = options.surfaceTolerancePct ?? DEFAULT_SURFACE_TOLERANCE_PCT;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const surfaceWindow = buildSurfaceWindow(subject.surfaceM2, surfaceTolerancePct);
  const normalized = candidates
    .map((candidate) =>
      normalizeCandidate({
        candidate,
        subject,
        now,
        maxAgeMonths,
      }),
    )
    .filter((candidate): candidate is NormalizedComparable => candidate != null)
    .filter(
      (candidate) =>
        candidate.monthsOld <= maxAgeMonths &&
        (candidate.distanceM == null || candidate.distanceM <= maxRadiusM),
    );

  const scope = selectComparableScope({
    candidates: normalized,
    surfaceWindow,
    maxRadiusM,
    minSampleSize,
  });

  if (!scope || scope.candidates.length === 0) {
    return missingAnalysis({
      candidates,
      normalized,
      maxAgeMonths,
      surfaceWindow,
      warnings: ["Aucun comparable DVF exploitable dans le périmètre et la période demandés."],
    });
  }

  const outlierFiltered = removeOutliers(scope.candidates);
  const scored = outlierFiltered.values
    .map((candidate) =>
      scoreComparable({
        candidate,
        subject,
        radiusM: scope.radiusM,
        maxAgeMonths,
        surfaceTolerancePct,
      }),
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const sortedPrices = scored.map((candidate) => candidate.pricePerM2).sort((a, b) => a - b);
  const p25 = percentileRounded(sortedPrices, 0.25);
  const median = percentileRounded(sortedPrices, 0.5);
  const p75 = percentileRounded(sortedPrices, 0.75);
  const weightedAverage = weightedAveragePrice(scored);
  const confidence = assessConfidence({
    scored,
    mode: scope.mode,
    radiusM: scope.radiusM,
    median,
    p25,
    p75,
    outliersRemoved: outlierFiltered.removed,
    maxAgeMonths,
  });
  const valueRange = buildValueRange({
    surfaceM2: subject.surfaceM2,
    p25,
    median,
    p75,
    startingPriceEur: subject.startingPriceEur,
  });
  const status = resolveStatus(scored.length, confidence.score);
  const warnings = buildWarnings({
    sampleSize: scored.length,
    mode: scope.mode,
    radiusM: scope.radiusM,
    maxRadiusM,
    outliersRemoved: outlierFiltered.removed,
    confidenceLabel: confidence.label,
  });

  return {
    available: scored.length > 0,
    status,
    comparableMode: scope.mode,
    sampleSize: scored.length,
    totalCandidateCount: candidates.length,
    excludedCandidateCount: Math.max(0, candidates.length - scored.length),
    outliersRemoved: outlierFiltered.removed,
    radiusM: scope.radiusM,
    maxAgeMonths,
    surfaceWindow,
    confidenceScore: confidence.score,
    confidenceLabel: confidence.label,
    medianPricePerM2: median,
    weightedAveragePricePerM2: weightedAverage,
    p25PricePerM2: p25,
    p75PricePerM2: p75,
    ...valueRange,
    comparables: scored,
    warnings,
    summary: summary({
      sampleSize: scored.length,
      radiusM: scope.radiusM,
      mode: scope.mode,
      median,
      weightedAverage,
      confidenceLabel: confidence.label,
    }),
    nextActions: nextActions({
      status,
      mode: scope.mode,
      sampleSize: scored.length,
      hasSurface: subject.surfaceM2 != null,
    }),
    limitations: [
      "DVF ne décrit pas l'état intérieur, les travaux, l'occupation ni les qualités fines du bien.",
      "Les ventes très récentes peuvent manquer selon le délai de publication DVF.",
      "La fourchette doit être relue avec les pièces judiciaires avant de fixer une mise maximale.",
    ],
  };
}

function normalizeCandidate({
  candidate,
  subject,
  now,
  maxAgeMonths,
}: {
  candidate: DvfComparableCandidate;
  subject: DvfComparableSubject;
  now: Date;
  maxAgeMonths: number;
}): NormalizedComparable | null {
  const surfaceM2 = positiveNumber(candidate.surfaceM2);
  const totalPriceEur = positiveNumber(candidate.totalPriceEur);
  const candidatePricePerM2 = positiveNumber(candidate.pricePerM2);
  const pricePerM2 =
    candidatePricePerM2 ?? (surfaceM2 && totalPriceEur ? totalPriceEur / surfaceM2 : null);
  const saleDate = parseDate(candidate.saleDate);
  if (!surfaceM2 || surfaceM2 < MIN_SURFACE_M2 || !pricePerM2 || !saleDate) return null;
  if (pricePerM2 < MIN_PRICE_PER_M2 || pricePerM2 > MAX_PRICE_PER_M2) return null;

  const monthsOld = Math.max(0, monthDistance(saleDate, now));
  if (monthsOld > maxAgeMonths * 1.5) return null;
  const surfaceDeltaPct =
    subject.surfaceM2 && subject.surfaceM2 > 0
      ? ((surfaceM2 - subject.surfaceM2) / subject.surfaceM2) * 100
      : null;

  return {
    ...candidate,
    surfaceM2,
    totalPriceEur,
    pricePerM2,
    monthsOld,
    surfaceDeltaPct,
    typeMatch: comparableTypeMatch(candidate.propertyType, subject.propertyType),
  };
}

function selectComparableScope({
  candidates,
  surfaceWindow,
  maxRadiusM,
  minSampleSize,
}: {
  candidates: NormalizedComparable[];
  surfaceWindow: DvfComparableAnalysis["surfaceWindow"];
  maxRadiusM: number;
  minSampleSize: number;
}): ComparableScope | null {
  const steps = RADIUS_STEPS_M.filter((radius) => radius <= maxRadiusM);
  if (!steps.includes(maxRadiusM)) steps.push(maxRadiusM);
  const uniqueSteps = Array.from(new Set(steps)).sort((a, b) => a - b);

  for (const radiusM of uniqueSteps) {
    const inRadius = candidates.filter(
      (candidate) => candidate.distanceM == null || candidate.distanceM <= radiusM,
    );
    const strict = inRadius.filter(
      (candidate) =>
        candidate.typeMatch &&
        inSurfaceWindow(candidate.surfaceM2, surfaceWindow.minM2, surfaceWindow.maxM2),
    );
    if (strict.length >= minSampleSize) {
      return { radiusM, mode: "surface_matched", candidates: strict };
    }
  }

  for (const radiusM of uniqueSteps) {
    const typeOnly = candidates.filter(
      (candidate) =>
        candidate.typeMatch && (candidate.distanceM == null || candidate.distanceM <= radiusM),
    );
    if (typeOnly.length >= minSampleSize) {
      return { radiusM, mode: "nearby_type_only", candidates: typeOnly };
    }
  }

  const fallback = candidates.filter(
    (candidate) => candidate.distanceM == null || candidate.distanceM <= maxRadiusM,
  );
  if (fallback.length > 0)
    return { radiusM: maxRadiusM, mode: "expanded_fallback", candidates: fallback };
  return null;
}

function scoreComparable({
  candidate,
  subject,
  radiusM,
  maxAgeMonths,
  surfaceTolerancePct,
}: {
  candidate: NormalizedComparable;
  subject: DvfComparableSubject;
  radiusM: number;
  maxAgeMonths: number;
  surfaceTolerancePct: number;
}): ScoredDvfComparable {
  const distanceScore =
    candidate.distanceM == null
      ? 0.55
      : Math.max(0, 1 - candidate.distanceM / Math.max(radiusM, 1));
  const recencyScore = Math.max(0, 1 - candidate.monthsOld / Math.max(maxAgeMonths, 1));
  const surfaceScore =
    candidate.surfaceDeltaPct == null
      ? 0.65
      : Math.max(0, 1 - Math.abs(candidate.surfaceDeltaPct) / Math.max(surfaceTolerancePct * 2, 1));
  const typeScore = candidate.typeMatch ? 1 : 0.35;
  const score = Math.round(
    Math.min(
      100,
      Math.max(0, distanceScore * 35 + recencyScore * 25 + surfaceScore * 25 + typeScore * 15),
    ),
  );

  return {
    ...candidate,
    pricePerM2: Math.round(candidate.pricePerM2),
    monthsOld: Math.round(candidate.monthsOld * 10) / 10,
    surfaceDeltaPct:
      candidate.surfaceDeltaPct == null ? null : Math.round(candidate.surfaceDeltaPct * 10) / 10,
    score,
    scoreBreakdown: {
      distance: Math.round(distanceScore * 100),
      recency: Math.round(recencyScore * 100),
      surface: Math.round(surfaceScore * 100),
      type: Math.round(typeScore * 100),
    },
    reasons: comparableReasons({ candidate, subject }),
  };
}

function comparableReasons({
  candidate,
  subject,
}: {
  candidate: NormalizedComparable;
  subject: DvfComparableSubject;
}): string[] {
  const reasons: string[] = [];
  if (candidate.distanceM != null) {
    reasons.push(
      candidate.distanceM <= 300 ? "très proche" : `à ${Math.round(candidate.distanceM)} m`,
    );
  }
  if (candidate.monthsOld <= 12) reasons.push("vente récente");
  else if (candidate.monthsOld <= 36) reasons.push("moins de 36 mois");
  if (candidate.typeMatch) reasons.push("même type");
  if (subject.surfaceM2 && candidate.surfaceDeltaPct != null) {
    reasons.push(
      Math.abs(candidate.surfaceDeltaPct) <= 30
        ? "surface comparable"
        : `surface ${candidate.surfaceDeltaPct > 0 ? "+" : ""}${Math.round(candidate.surfaceDeltaPct)} %`,
    );
  }
  return reasons.slice(0, 4);
}

function buildSurfaceWindow(
  surfaceM2: number | null | undefined,
  tolerancePct: number,
): DvfComparableAnalysis["surfaceWindow"] {
  const surface = positiveNumber(surfaceM2);
  if (!surface) return { minM2: null, maxM2: null, tolerancePct: null };
  const ratio = tolerancePct / 100;
  return {
    minM2: Math.max(MIN_SURFACE_M2, Math.round(surface * (1 - ratio))),
    maxM2: Math.round(surface * (1 + ratio)),
    tolerancePct,
  };
}

function inSurfaceWindow(value: number, minM2: number | null, maxM2: number | null): boolean {
  if (minM2 == null || maxM2 == null) return true;
  return value >= minM2 && value <= maxM2;
}

function removeOutliers(values: NormalizedComparable[]): {
  values: NormalizedComparable[];
  removed: number;
} {
  if (values.length < 7) return { values, removed: 0 };
  const prices = values.map((value) => value.pricePerM2).sort((a, b) => a - b);
  const p25 = percentile(prices, 0.25);
  const p75 = percentile(prices, 0.75);
  const iqr = p75 - p25;
  if (iqr <= 0) return { values, removed: 0 };
  const lower = Math.max(MIN_PRICE_PER_M2, p25 - 1.5 * iqr);
  const upper = Math.min(MAX_PRICE_PER_M2, p75 + 1.5 * iqr);
  const filtered = values.filter((value) => value.pricePerM2 >= lower && value.pricePerM2 <= upper);
  return filtered.length >= 4
    ? { values: filtered, removed: values.length - filtered.length }
    : { values, removed: 0 };
}

function assessConfidence({
  scored,
  mode,
  radiusM,
  median,
  p25,
  p75,
  outliersRemoved,
  maxAgeMonths,
}: {
  scored: ScoredDvfComparable[];
  mode: DvfComparableMode;
  radiusM: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
  outliersRemoved: number;
  maxAgeMonths: number;
}): { score: number; label: DvfComparableAnalysis["confidenceLabel"] } {
  let score = 35;
  score += Math.min(35, scored.length * 5);
  if (mode === "surface_matched") score += 15;
  if (mode === "expanded_fallback") score -= 12;
  if (radiusM > 1_000) score -= 8;
  if (outliersRemoved > 0) score -= Math.min(10, outliersRemoved * 2);
  const averageAge =
    scored.reduce((sum, candidate) => sum + candidate.monthsOld, 0) / Math.max(scored.length, 1);
  if (averageAge <= maxAgeMonths / 3) score += 6;

  if (median && p25 && p75) {
    const dispersion = (p75 - p25) / median;
    if (dispersion > 0.45) score -= 14;
    else if (dispersion > 0.3) score -= 7;
  }

  const normalized = Math.max(0, Math.min(100, Math.round(score)));
  if (normalized >= 78) return { score: normalized, label: "forte" };
  if (normalized >= 58) return { score: normalized, label: "correcte" };
  return { score: normalized, label: "fragile" };
}

function buildValueRange({
  surfaceM2,
  p25,
  median,
  p75,
  startingPriceEur,
}: {
  surfaceM2: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  startingPriceEur?: number | null;
}): Pick<
  DvfComparableAnalysis,
  "lowValueEur" | "medianValueEur" | "highValueEur" | "apparentDiscountPct"
> {
  const surface = positiveNumber(surfaceM2);
  const lowValueEur = surface && p25 ? Math.round(surface * p25) : null;
  const medianValueEur = surface && median ? Math.round(surface * median) : null;
  const highValueEur = surface && p75 ? Math.round(surface * p75) : null;
  const starting = positiveNumber(startingPriceEur);
  const apparentDiscountPct =
    starting && medianValueEur ? Math.round((1 - starting / medianValueEur) * 1000) / 10 : null;
  return { lowValueEur, medianValueEur, highValueEur, apparentDiscountPct };
}

function weightedAveragePrice(comparables: ScoredDvfComparable[]): number | null {
  const totalWeight = comparables.reduce((sum, comparable) => sum + comparable.score, 0);
  if (totalWeight <= 0) return null;
  return Math.round(
    comparables.reduce((sum, comparable) => sum + comparable.pricePerM2 * comparable.score, 0) /
      totalWeight,
  );
}

function resolveStatus(
  sampleSize: number,
  confidenceScore: number,
): DvfComparableAnalysis["status"] {
  if (sampleSize >= 6 && confidenceScore >= 78) return "detailed";
  if (sampleSize >= 4 && confidenceScore >= 58) return "usable";
  if (sampleSize > 0) return "weak";
  return "missing";
}

function buildWarnings({
  sampleSize,
  mode,
  radiusM,
  maxRadiusM,
  outliersRemoved,
  confidenceLabel,
}: {
  sampleSize: number;
  mode: DvfComparableMode;
  radiusM: number;
  maxRadiusM: number;
  outliersRemoved: number;
  confidenceLabel: DvfComparableAnalysis["confidenceLabel"];
}): string[] {
  const warnings: string[] = [];
  if (sampleSize < DEFAULT_MIN_SAMPLE_SIZE) warnings.push("échantillon DVF court");
  if (mode !== "surface_matched") warnings.push("surfaces élargies faute de références strictes");
  if (radiusM === maxRadiusM && maxRadiusM > 1_000) warnings.push(`rayon élargi à ${radiusM} m`);
  if (outliersRemoved > 0) warnings.push(`${outliersRemoved} valeur(s) aberrante(s) ignorée(s)`);
  if (confidenceLabel === "fragile")
    warnings.push("confiance à renforcer avant décision d'enchère");
  return warnings;
}

function summary({
  sampleSize,
  radiusM,
  mode,
  median,
  weightedAverage,
  confidenceLabel,
}: {
  sampleSize: number;
  radiusM: number;
  mode: DvfComparableMode;
  median: number | null;
  weightedAverage: number | null;
  confidenceLabel: DvfComparableAnalysis["confidenceLabel"];
}): string {
  const modeLabel: Record<DvfComparableMode, string> = {
    surface_matched: "surface et type comparables",
    nearby_type_only: "type comparable, surfaces élargies",
    expanded_fallback: "périmètre élargi",
  };
  const price = median ? `médiane ${formatPerM2(median)}` : "médiane à compléter";
  const weighted = weightedAverage ? `pondérée ${formatPerM2(weightedAverage)}` : null;
  return [
    `${sampleSize} vente(s) DVF retenue(s)`,
    `rayon ${radiusM} m`,
    modeLabel[mode],
    price,
    weighted,
    `confiance ${confidenceLabel}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function nextActions({
  status,
  mode,
  sampleSize,
  hasSurface,
}: {
  status: DvfComparableAnalysis["status"];
  mode: DvfComparableMode;
  sampleSize: number;
  hasSurface: boolean;
}): string[] {
  const actions: string[] = [];
  if (!hasSurface)
    actions.push("Renseigner ou confirmer la surface pour resserrer les comparables.");
  if (mode !== "surface_matched") {
    actions.push(
      "Relire manuellement les ventes retenues avant de considérer la fourchette comme principale.",
    );
  }
  if (sampleSize < 6 || status === "weak") {
    actions.push(
      "Compléter avec des références notaires/agences ou élargir le périmètre de contrôle.",
    );
  }
  actions.push("Utiliser la valeur basse pour les scénarios prudents de mise maximale.");
  return actions.slice(0, 4);
}

function missingAnalysis({
  candidates,
  normalized,
  maxAgeMonths,
  surfaceWindow,
  warnings,
}: {
  candidates: DvfComparableCandidate[];
  normalized: NormalizedComparable[];
  maxAgeMonths: number;
  surfaceWindow: DvfComparableAnalysis["surfaceWindow"];
  warnings: string[];
}): DvfComparableAnalysis {
  return {
    available: false,
    status: "missing",
    comparableMode: null,
    sampleSize: 0,
    totalCandidateCount: candidates.length,
    excludedCandidateCount: Math.max(0, candidates.length - normalized.length),
    outliersRemoved: 0,
    radiusM: null,
    maxAgeMonths,
    surfaceWindow,
    confidenceScore: 0,
    confidenceLabel: "indisponible",
    medianPricePerM2: null,
    weightedAveragePricePerM2: null,
    p25PricePerM2: null,
    p75PricePerM2: null,
    lowValueEur: null,
    medianValueEur: null,
    highValueEur: null,
    apparentDiscountPct: null,
    comparables: [],
    warnings,
    summary: "Aucun comparable DVF exploitable n'a été retenu.",
    nextActions: [
      "Vérifier le géocodage du bien et relancer avec un rayon plus large.",
      "Renseigner une hypothèse de marché documentée avant de calculer la mise maximale.",
    ],
    limitations: [
      "Sans comparable DVF, l'estimation automatique doit être considérée comme indisponible.",
    ],
  };
}

function percentileRounded(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  return Math.round(percentile(sortedAsc, p));
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function monthDistance(from: Date, to: Date): number {
  const ms = Math.max(0, to.getTime() - from.getTime());
  return ms / (1000 * 60 * 60 * 24 * 30.4375);
}

function positiveNumber(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function propertyTypeFamily(value: string | null | undefined): string {
  const text = (value ?? "").toLowerCase();
  if (/maison|house|villa|pavillon/.test(text)) return "house";
  if (/appartement|apartment|studio|t1|t2|t3|t4/.test(text)) return "apartment";
  if (/immeuble|building/.test(text)) return "building";
  if (/terrain|land/.test(text)) return "land";
  return text.trim() || "unknown";
}

function comparableTypeMatch(
  candidateType: string | null | undefined,
  subjectType: string | null | undefined,
): boolean {
  const subjectFamily = propertyTypeFamily(subjectType);
  const candidateFamily = propertyTypeFamily(candidateType);
  if (subjectFamily === "unknown") return true;
  if (candidateFamily === "unknown") return false;
  return candidateFamily === subjectFamily;
}

function formatPerM2(value: number): string {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(value)} €/m²`;
}
