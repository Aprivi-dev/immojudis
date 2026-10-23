import { beforeEach, describe, expect, it, vi } from "vitest";

const loadActiveValuationModel = vi.hoisted(() => vi.fn());
vi.mock("@/lib/valuation-model-registry", () => ({ loadActiveValuationModel }));
const predictLightGbmQuantiles = vi.hoisted(() => vi.fn());
vi.mock("@/lib/lightgbm-inference", () => ({ predictLightGbmQuantiles }));

import { applyActiveHybridModel, type HybridValuationInput } from "@/lib/hybrid-market-valuation";

const input: HybridValuationInput = {
  segment: "apartment",
  surfaceM2: 70,
  landSurfaceM2: null,
  roomsCount: 3,
  latitude: 48.8566,
  longitude: 2.3522,
  comparableMedianPricePerM2: 9_000,
  comparableP10PricePerM2: 7_500,
  comparableP90PricePerM2: 10_800,
  comparableSampleSize: 9,
  comparableQualityScore: 70,
  annualMarketTrendPct: 1,
  radiusM: 300,
  now: new Date("2026-10-23T00:00:00Z"),
};

const parisCell9 = "891fb466257ffff";

function localMarket(overrides: Record<string, unknown> = {}) {
  return {
    formatVersion: 1,
    algorithm: { minSample: 5, spreadMultiplier: 2.563, spreadFloor: 0.05, sampleSizeCap: 100 },
    resolutions: [9, 8, 7],
    fallback: { mean: 8.1, spread: 0.9 },
    cells: { "9": { [parisCell9]: [40, 8.9, 0.2] } },
    ...overrides,
  };
}

function model(artifact: Record<string, unknown>) {
  return {
    id: "model-1",
    version: "v1",
    segment: "apartment",
    framework: "lightgbm_quantile",
    feature_names: [],
    artifact,
    calibration: {},
    training_metrics: { test_mape_pct: 12 },
  };
}

beforeEach(() => {
  loadActiveValuationModel.mockReset();
  predictLightGbmQuantiles.mockReset();
  predictLightGbmQuantiles.mockReturnValue({
    p10PricePerM2: 7_800,
    p50PricePerM2: 9_200,
    p90PricePerM2: 10_900,
    coverageTarget: 0.8,
    calibrationMethod: "mapie_cqr",
  });
});

describe("variables locales du modèle hybride", () => {
  it("lit les variables locales dans l'export de l'artefact, comme à l'entraînement", async () => {
    loadActiveValuationModel.mockResolvedValue(model({ localMarket: localMarket() }));
    const result = await applyActiveHybridModel(input);
    expect(result).not.toBeNull();
    const features = predictLightGbmQuantiles.mock.calls[0][1];
    expect(features.local_median_log).toBeCloseTo(8.9, 10);
    expect(features.local_spread_log).toBeCloseTo(0.2 * 2.563, 10);
    expect(features.local_sample_size_log).toBeCloseTo(Math.log1p(40), 10);
    // Ce ne sont pas les valeurs que donnaient les comparables du moteur.
    expect(features.local_median_log).not.toBeCloseTo(Math.log(9_000), 3);
  });

  it("n'applique pas le modèle quand l'export est d'un format inconnu", async () => {
    loadActiveValuationModel.mockResolvedValue(
      model({ localMarket: localMarket({ formatVersion: 2 }) }),
    );
    expect(await applyActiveHybridModel(input)).toBeNull();
    expect(predictLightGbmQuantiles).not.toHaveBeenCalled();
  });

  it("garde l'ancienne approximation pour un artefact antérieur à l'export", async () => {
    loadActiveValuationModel.mockResolvedValue(model({}));
    expect(await applyActiveHybridModel(input)).not.toBeNull();
    const features = predictLightGbmQuantiles.mock.calls[0][1];
    expect(features.local_median_log).toBeCloseTo(Math.log(9_000), 10);
    expect(features.local_spread_log).toBeCloseTo(Math.log(10_800 / 7_500), 10);
    expect(features.local_sample_size_log).toBeCloseTo(Math.log1p(9), 10);
  });
});
