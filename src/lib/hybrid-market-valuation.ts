import { predictLightGbmQuantiles } from "@/lib/lightgbm-inference";
import type { MarketPropertySegment } from "@/lib/market-estimation-engine";
import { loadActiveValuationModel } from "@/lib/valuation-model-registry";

type SupportedSegment = Exclude<MarketPropertySegment, "unsupported">;

export type HybridValuationInput = {
  segment: SupportedSegment;
  surfaceM2: number;
  landSurfaceM2: number | null;
  roomsCount: number | null;
  latitude: number;
  longitude: number;
  comparableMedianPricePerM2: number;
  comparableP10PricePerM2: number;
  comparableP90PricePerM2: number;
  comparableSampleSize: number;
  comparableQualityScore: number;
  annualMarketTrendPct: number;
  radiusM: number;
  now?: Date;
};

export type HybridValuationResult = {
  modelVersionId: string;
  modelVersion: string;
  p10PricePerM2: number;
  p50PricePerM2: number;
  p90PricePerM2: number;
  modelWeight: number;
  coverageTarget: number;
  calibrationMethod: string;
  rawModelPrediction: {
    p10PricePerM2: number;
    p50PricePerM2: number;
    p90PricePerM2: number;
  };
};

export async function applyActiveHybridModel(
  input: HybridValuationInput,
): Promise<HybridValuationResult | null> {
  const model = await loadActiveValuationModel(input.segment);
  if (!model || model.framework !== "lightgbm_quantile") return null;
  const prediction = predictLightGbmQuantiles(model.artifact, valuationFeatures(input));
  if (!prediction) return null;

  const modelWeight = resolveModelWeight(input.comparableQualityScore, model.training_metrics);
  const p50 = geometricBlend(
    input.comparableMedianPricePerM2,
    prediction.p50PricePerM2,
    modelWeight,
  );
  const p10 = Math.min(
    p50,
    geometricBlend(input.comparableP10PricePerM2, prediction.p10PricePerM2, modelWeight),
  );
  const p90 = Math.max(
    p50,
    geometricBlend(input.comparableP90PricePerM2, prediction.p90PricePerM2, modelWeight),
  );

  return {
    modelVersionId: model.id,
    modelVersion: model.version,
    p10PricePerM2: Math.round(p10),
    p50PricePerM2: Math.round(p50),
    p90PricePerM2: Math.round(p90),
    modelWeight: round(modelWeight, 2),
    coverageTarget: prediction.coverageTarget,
    calibrationMethod: prediction.calibrationMethod,
    rawModelPrediction: {
      p10PricePerM2: prediction.p10PricePerM2,
      p50PricePerM2: prediction.p50PricePerM2,
      p90PricePerM2: prediction.p90PricePerM2,
    },
  };
}

function valuationFeatures(input: HybridValuationInput): Record<string, number | null> {
  const now = input.now ?? new Date();
  const monthAngle = (2 * Math.PI * now.getUTCMonth()) / 12;
  return {
    surface_m2: input.surfaceM2,
    log_surface_m2: Math.log(input.surfaceM2),
    land_surface_m2: input.landSurfaceM2,
    log_land_surface_m2: input.landSurfaceM2 ? Math.log(input.landSurfaceM2) : null,
    rooms_count: input.roomsCount,
    latitude: input.latitude,
    longitude: input.longitude,
    sale_year: now.getUTCFullYear(),
    sale_month_sin: Math.sin(monthAngle),
    sale_month_cos: Math.cos(monthAngle),
    local_median_log: Math.log(input.comparableMedianPricePerM2),
    local_spread_log: Math.log(input.comparableP90PricePerM2 / input.comparableP10PricePerM2),
    local_sample_size: input.comparableSampleSize,
    local_sample_size_log: Math.log1p(input.comparableSampleSize),
    local_quality_score: input.comparableQualityScore,
    annual_market_trend_pct: input.annualMarketTrendPct,
    radius_m: input.radiusM,
  };
}

function resolveModelWeight(qualityScore: number, metrics: unknown): number {
  const metricMap =
    metrics && typeof metrics === "object" ? (metrics as Record<string, unknown>) : {};
  const testMape = finiteNumber(metricMap.test_mape_pct);
  const qualityWeight = qualityScore >= 78 ? 0.35 : qualityScore >= 58 ? 0.45 : 0.6;
  if (testMape == null) return qualityWeight;
  const performanceAdjustment = Math.max(-0.12, Math.min(0.08, (16 - testMape) / 100));
  const performanceCap = testMape >= 35 ? 0.3 : testMape >= 25 ? 0.45 : 0.7;
  return Math.max(0.2, Math.min(performanceCap, qualityWeight + performanceAdjustment));
}

function geometricBlend(comparable: number, model: number, modelWeight: number): number {
  const comparableWeight = 1 - modelWeight;
  return Math.exp(Math.log(comparable) * comparableWeight + Math.log(model) * modelWeight);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
