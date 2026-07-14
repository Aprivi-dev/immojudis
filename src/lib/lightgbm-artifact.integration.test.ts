import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { predictLightGbmQuantiles } from "@/lib/lightgbm-inference";

const artifactDirectory = join(process.cwd(), "deployment", "valuation-models");
const cases = [
  { segment: "apartment", surfaceM2: 70, landSurfaceM2: null, roomsCount: 3 },
  { segment: "house", surfaceM2: 120, landSurfaceM2: 500, roomsCount: 5 },
] as const;
const artifactsAvailable = cases.every(({ segment }) =>
  existsSync(join(artifactDirectory, `${segment}-lgbm-cqr-20260713.json`)),
);

describe.skipIf(!artifactsAvailable)("generated LightGBM production artifacts", () => {
  for (const modelCase of cases) {
    it(`evaluates the real ${modelCase.segment} dump with the production feature contract`, () => {
      const bundle = JSON.parse(
        readFileSync(
          join(artifactDirectory, `${modelCase.segment}-lgbm-cqr-20260713.json`),
          "utf8",
        ),
      ) as { artifact: unknown; featureNames: string[] };
      expect(bundle.featureNames).toEqual(
        expect.arrayContaining(["local_median_log", "local_spread_log", "local_sample_size_log"]),
      );

      const prediction = predictLightGbmQuantiles(bundle.artifact, {
        surface_m2: modelCase.surfaceM2,
        log_surface_m2: Math.log(modelCase.surfaceM2),
        land_surface_m2: modelCase.landSurfaceM2,
        log_land_surface_m2: modelCase.landSurfaceM2 ? Math.log(modelCase.landSurfaceM2) : null,
        rooms_count: modelCase.roomsCount,
        latitude: 48.8566,
        longitude: 2.3522,
        sale_year: 2026,
        sale_month_sin: 0,
        sale_month_cos: -1,
        local_median_log: Math.log(9_500),
        local_spread_log: Math.log(1.45),
        local_sample_size_log: Math.log1p(12),
      });

      expect(prediction).not.toBeNull();
      expect(prediction!.p10PricePerM2).toBeGreaterThan(300);
      expect(prediction!.p10PricePerM2).toBeLessThanOrEqual(prediction!.p50PricePerM2);
      expect(prediction!.p50PricePerM2).toBeLessThanOrEqual(prediction!.p90PricePerM2);
      expect(prediction!.p90PricePerM2).toBeLessThan(50_000);
    });
  }
});
