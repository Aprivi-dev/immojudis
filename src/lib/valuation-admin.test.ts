import { describe, expect, it } from "vitest";
import { evaluateValuationPromotionGate, summarizeValuationRuntime } from "@/lib/valuation-admin";

describe("valuation admin runtime summary", () => {
  it("summarizes model adoption and runtime quality without exposing inputs", () => {
    const runtime = summarizeValuationRuntime([
      {
        engine_kind: "hybrid_lightgbm",
        segment: "apartment",
        confidence_score: 80,
        comparable_count: 10,
        actionable: true,
        latency_ms: 120,
        created_at: "2026-07-13T10:00:00Z",
      },
      {
        engine_kind: "comparable_ensemble",
        segment: "house",
        confidence_score: 60,
        comparable_count: 6,
        actionable: false,
        latency_ms: 280,
        created_at: "2026-07-13T11:00:00Z",
      },
    ]);

    expect(runtime).toEqual({
      windowHours: 24,
      estimates: 2,
      hybridSharePct: 50,
      actionableSharePct: 50,
      averageConfidenceScore: 70,
      averageComparableCount: 8,
      averageLatencyMs: 200,
      bySegment: { apartment: 1, house: 1 },
      status: "healthy",
      driftSignals: [],
    });
  });

  it("mirrors the training promotion gates in the admin cockpit", () => {
    expect(
      evaluateValuationPromotionGate({
        testMapePct: 31,
        testMedianApePct: 22,
        intervalCoveragePct: 80,
        intervalMeanWidthPct: 90,
        testRows: 120,
      }),
    ).toEqual({ passes: true, failures: [] });

    const rejected = evaluateValuationPromotionGate({
      testMapePct: 45,
      testMedianApePct: 35,
      intervalCoveragePct: 65,
      intervalMeanWidthPct: 130,
      testRows: 20,
    });
    expect(rejected.passes).toBe(false);
    expect(rejected.failures).toHaveLength(5);
  });
});
