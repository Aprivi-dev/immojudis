import { describe, expect, it } from "vitest";
import { predictLightGbmQuantiles } from "@/lib/lightgbm-inference";

describe("LightGBM JSON inference", () => {
  it("evaluates quantile trees and applies conformal corrections", () => {
    const artifact = {
      format: "lightgbm-json-v1",
      target: "log_price_per_m2",
      featureNames: ["surface_m2"],
      models: {
        p10: { tree_info: [{ tree_structure: { leaf_value: Math.log(2_000) } }] },
        p50: { tree_info: [{ tree_structure: { leaf_value: Math.log(2_500) } }] },
        p90: { tree_info: [{ tree_structure: { leaf_value: Math.log(3_000) } }] },
      },
      calibration: {
        confidenceLevel: 0.8,
        lowerCorrection: Math.log(1.05),
        upperCorrection: Math.log(1.1),
        method: "mapie_cqr",
      },
    };

    const prediction = predictLightGbmQuantiles(artifact, { surface_m2: 80 });

    expect(prediction).toMatchObject({
      p50PricePerM2: 2_500,
      p90PricePerM2: 3_300,
      coverageTarget: 0.8,
      calibrationMethod: "mapie_cqr",
    });
    expect(prediction?.p10PricePerM2).toBeCloseTo(1_905, -1);
  });

  it("follows numeric splits and their missing-value direction", () => {
    const splitTree = {
      split_feature: 0,
      threshold: 100,
      decision_type: "<=",
      default_left: true,
      left_child: { leaf_value: Math.log(1_500) },
      right_child: { leaf_value: Math.log(2_500) },
    };
    const artifact = {
      format: "lightgbm-json-v1",
      target: "log_price_per_m2",
      featureNames: ["surface_m2"],
      models: {
        p10: { tree_info: [{ tree_structure: splitTree }] },
        p50: { tree_info: [{ tree_structure: splitTree }] },
        p90: { tree_info: [{ tree_structure: splitTree }] },
      },
    };

    expect(predictLightGbmQuantiles(artifact, { surface_m2: 120 })?.p50PricePerM2).toBe(2_500);
    expect(predictLightGbmQuantiles(artifact, { surface_m2: null })?.p50PricePerM2).toBe(1_500);
  });
});
