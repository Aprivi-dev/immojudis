import { asRecord } from "@/lib/guards";
import { predictLightGbmQuantiles } from "@/lib/lightgbm-inference";
import { hasLocalMarketExport, localMarketFeaturesFromArtifact } from "@/lib/local-market-features";
import { VALUATION_MODEL_MIN_COVERAGE_PCT } from "@/lib/market-comparable-minimums";
import type { MarketPropertySegment } from "@/lib/market-estimation-engine";
import { loadActiveValuationModel } from "@/lib/valuation-model-registry";
import { round } from "@/lib/rounding";

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
  /**
   * Pas de couverture annoncée (`coverageTarget` du modèle seul : 0,8) : la fourchette servie mélange le
   * modèle et les comparables, et la couverture de ce mélange n'est pas mesurée (n° 21). Elle est donc
   * présentée comme une « fourchette indicative » à l'écran, jamais comme un intervalle à 80 %.
   */
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
  if (!coverageMeasuredByGate(model.training_metrics)) return null;
  const features = valuationFeatures(input, model.artifact);
  if (!features) return null;
  const prediction = predictLightGbmQuantiles(model.artifact, features);
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
    calibrationMethod: prediction.calibrationMethod,
    rawModelPrediction: {
      p10PricePerM2: prediction.p10PricePerM2,
      p50PricePerM2: prediction.p50PricePerM2,
      p90PricePerM2: prediction.p90PricePerM2,
    },
  };
}

/**
 * D2 (14/11) : un modèle actif n'est utilisé que si la porte d'activation a mesuré la couverture de
 * son intervalle sur les ventes les plus récentes, mises de côté pendant son entraînement
 * (`training_metrics.comparison`, écrit par `published_training_metrics` de
 * `valuation_training.py`), et qu'elle atteint le plancher de mise
 * en service (`VALUATION_MODEL_MIN_COVERAGE_PCT`, recopié de `valuation_activation_gate.py`). Un
 * modèle activé sans cette mesure (comme les deux `lgbm-cqr-20260713` activés le 27/07/2026, avant
 * la porte) ou remis en service à la main sous le plancher n'est pas utilisé : l'estimation est
 * celle des comparables seuls. C'est ce que dit la page méthode.
 */
function coverageMeasuredByGate(trainingMetrics: unknown): boolean {
  const comparison = asRecord(asRecord(trainingMetrics).comparison);
  const coverage = finiteNumber(comparison.served_interval_coverage_pct);
  return coverage !== null && coverage >= VALUATION_MODEL_MIN_COVERAGE_PCT;
}

/**
 * Variables du modèle. Les trois variables de marché local viennent de l'export `localMarket` de
 * l'artefact (`local-market-features.ts`), c'est-à-dire du même calcul qu'à l'entraînement : un
 * modèle n'est jamais alimenté avec des variables locales construites autrement que celles sur
 * lesquelles il a appris. Un artefact sans cet export (antérieur à la porte d'activation, D2 du
 * 14/11), ou avec un export d'un format inconnu ou mal formé, fait renoncer au modèle (`null`) :
 * l'estimation reste alors celle des comparables.
 */
function valuationFeatures(
  input: HybridValuationInput,
  artifact: unknown,
): Record<string, number | null> | null {
  const now = input.now ?? new Date();
  const monthAngle = (2 * Math.PI * now.getUTCMonth()) / 12;
  if (!hasLocalMarketExport(artifact)) return null;
  const local = localMarketFeaturesFromArtifact(artifact, input.latitude, input.longitude);
  if (!local) return null;
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
    ...local,
    local_sample_size: input.comparableSampleSize,
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
