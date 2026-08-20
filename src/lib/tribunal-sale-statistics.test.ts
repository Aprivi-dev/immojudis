import { describe, expect, it } from "vitest";
import {
  formatProbability,
  formatRatioDelta,
  tribunalSaleCompactMetrics,
} from "@/lib/tribunal-sale-statistics";
import type { TribunalStatisticsItem } from "@/lib/tribunal-statistics";

describe("tribunal sale compact metrics", () => {
  it("uses adjusted published values and their own samples", () => {
    const item = {
      samples: { eligibleRounds: 126 },
      reliability: { coverage: 0.82 },
      priceRatios: {
        finalToInitial: { method: "empirical", adjusted: { p50: 1.68 }, sampleSize: 73 },
      },
      flow: {
        adjudicatedIfHeld: {
          method: "empirical",
          adjustedValue: 0.71,
          knownDenominator: 96,
        },
      },
      surenchere: {
        filed: { method: "empirical", adjustedValue: 0.14, knownDenominator: 88 },
      },
    } as unknown as TribunalStatisticsItem;

    expect(tribunalSaleCompactMetrics(item)).toEqual({
      eligibleRounds: 126,
      finalToInitialMedian: 1.68,
      finalToInitialSample: 73,
      adjudicatedRate: 0.71,
      adjudicatedSample: 96,
      overbidRate: 0.14,
      overbidSample: 88,
      coverage: 0.82,
    });
    expect(formatRatioDelta(1.68)).toBe("+68 %");
    expect(formatRatioDelta(0.88)).toBe("−12 %");
    expect(formatProbability(0.14)).toBe("14 %");
  });

  it("never leaks suppressed cells", () => {
    const item = {
      samples: { eligibleRounds: null },
      reliability: { coverage: null },
      priceRatios: {
        finalToInitial: { method: "suppressed" },
      },
      flow: { adjudicatedIfHeld: { method: "suppressed" } },
      surenchere: { filed: { method: "suppressed" } },
    } as unknown as TribunalStatisticsItem;

    expect(tribunalSaleCompactMetrics(item)).toEqual({
      eligibleRounds: null,
      finalToInitialMedian: null,
      finalToInitialSample: null,
      adjudicatedRate: null,
      adjudicatedSample: null,
      overbidRate: null,
      overbidSample: null,
      coverage: null,
    });
  });
});
