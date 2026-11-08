import { describe, expect, it } from "vitest";
import { EXAMPLE_MARKET_ESTIMATE } from "@/lib/example-sale";
import type { MarketEstimate } from "@/lib/market-server/types";
import {
  estimateSourceNote,
  observedMedianPricePerM2,
  passesPublicEstimateGate,
} from "@/lib/market-estimate-display";

const estimate = EXAMPLE_MARKET_ESTIMATE as MarketEstimate;

describe("passesPublicEstimateGate (D2)", () => {
  it("lets through the example estimate: 12 sales, effective 8.4, a 14 % wide range", () => {
    expect(passesPublicEstimateGate(estimate)).toBe(true);
  });

  it("stops what `actionable` accepts but the public gate does not", () => {
    // 5 ventes et un effectif de 3,4 : assez pour `actionable` (4 et 3), pas pour la porte (8 et 5).
    expect(passesPublicEstimateGate({ ...estimate, sampleSize: 5, effectiveSampleSize: 3.4 })).toBe(
      false,
    );
    // Fourchette de 70 % de la valeur : au-delà des 60 % de la porte.
    expect(
      passesPublicEstimateGate({
        ...estimate,
        estimatedValueLowEur: 160_000,
        estimatedValueHighEur: 321_000,
      }),
    ).toBe(false);
    expect(passesPublicEstimateGate({ ...estimate, actionable: false })).toBe(false);
  });
});

describe("estimateSourceNote", () => {
  it("names the model when it enters the value", () => {
    expect(estimateSourceNote({ engineKind: "hybrid_lightgbm", sampleSize: 12 })).toBe(
      "d’après des ventes comparables et un modèle statistique",
    );
  });

  it("says a whole number of sales, never an effective sample (D4)", () => {
    expect(estimateSourceNote({ engineKind: "comparable_ensemble", sampleSize: 9 })).toBe(
      "d’après 9 ventes comparables",
    );
    expect(estimateSourceNote({ sampleSize: 1 })).toBe("d’après 1 vente comparable");
    expect(estimateSourceNote({ sampleSize: 5.3 })).toBe("d’après des ventes comparables");
    expect(estimateSourceNote({ sampleSize: 0 })).toBe("d’après des ventes comparables");
  });
});

describe("observedMedianPricePerM2 (D2)", () => {
  it("prefers the median of the comparables to the hybrid p50", () => {
    expect(
      observedMedianPricePerM2({
        ...estimate,
        engineKind: "hybrid_lightgbm",
        medianPricePerM2: 3_600,
        comparableMedianPricePerM2: 3_382,
      }),
    ).toBe(3_382);
  });

  it("gives no median for an older hybrid estimate, and the plain one otherwise", () => {
    expect(observedMedianPricePerM2({ ...estimate, engineKind: "hybrid_lightgbm" })).toBeNull();
    expect(observedMedianPricePerM2(estimate)).toBe(3_382);
  });
});
