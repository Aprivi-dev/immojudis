import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MARKET_JACKKNIFE_MIN_COMPARABLES,
  MARKET_NON_JACKKNIFE_MIN_COMPARABLES,
  MARKET_WIDEN_UNTIL_COMPARABLES,
  VALUATION_MODEL_MIN_COVERAGE_PCT,
} from "@/lib/market-comparable-minimums";
import { passesPublicMarketGapGate } from "@/lib/market-gap-band";

const pythonGate = readFileSync(
  join(process.cwd(), "services/data-pipeline/src/valuation_activation_gate.py"),
  "utf8",
);

describe("seuils partagés entre le moteur, la porte publique et l'entraînement", () => {
  it("l'élargissement vise le plus petit effectif qui franchit la porte avec un intervalle jackknife", () => {
    const gate = (intervalMethod: string, comparableCount: number) =>
      passesPublicMarketGapGate({
        actionable: true,
        intervalMethod,
        comparableCount,
        effectiveSampleSize: comparableCount,
        p10: 95,
        p50: 100,
        p90: 105,
        radiusM: 150,
        segment: "apartment",
        areaKind: "urban",
      });
    expect(gate("local_jackknife", MARKET_WIDEN_UNTIL_COMPARABLES)).toBe(true);
    expect(gate("local_jackknife", MARKET_WIDEN_UNTIL_COMPARABLES - 1)).toBe(false);
    expect(MARKET_JACKKNIFE_MIN_COMPARABLES).toBeLessThan(MARKET_NON_JACKKNIFE_MIN_COMPARABLES);
  });

  it("le seuil de couverture de la page méthode est celui de la promotion d'un modèle (Python)", () => {
    const match = pythonGate.match(/^MIN_PROMOTION_COVERAGE_PCT = ([0-9.]+)$/m);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(VALUATION_MODEL_MIN_COVERAGE_PCT);
  });

  it("le niveau nominal visé reste de 80 %, au-dessus du seuil de promotion", () => {
    expect(pythonGate).toMatch(/^CONFIDENCE_LEVEL = 0\.8$/m);
    expect(VALUATION_MODEL_MIN_COVERAGE_PCT).toBeLessThan(80);
  });
});
