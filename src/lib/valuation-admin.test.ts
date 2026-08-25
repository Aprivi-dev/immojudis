import { describe, expect, it } from "vitest";
import {
  evaluateValuationPromotionGate,
  summarizeValuationAttempts,
  summarizeValuationQueue,
  summarizeValuationRuntime,
} from "@/lib/valuation-admin";

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

  it("marks a stale valuation backlog as degraded and includes failed attempts", () => {
    const now = new Date("2026-08-19T12:00:00Z");
    const queue = summarizeValuationQueue(
      [
        {
          status: "ready",
          estimate: { estimatedValueEur: 200_000 },
          actionable: true,
          next_refresh_at: "2026-08-20T12:00:00Z",
          last_error_code: null,
          priority: 0,
        },
        {
          status: "pending",
          estimate: null,
          actionable: false,
          next_refresh_at: "2026-08-19T10:00:00Z",
          last_error_code: "MISSING_SURFACE",
          priority: 100,
        },
      ],
      now,
    );
    expect(queue).toMatchObject({
      total: 2,
      served: 1,
      withoutEstimate: 1,
      coveragePct: 50,
      oldestDueMinutes: 120,
      highPriority: 1,
      status: "degraded",
      byErrorCode: { MISSING_SURFACE: 1 },
    });

    expect(
      summarizeValuationAttempts([
        {
          outcome: "ready",
          error_code: null,
          latency_ms: 500,
          created_at: "2026-08-19T11:00:00Z",
        },
        {
          outcome: "failed",
          error_code: "UPSTREAM_UNAVAILABLE",
          latency_ms: 1_500,
          created_at: "2026-08-19T11:05:00Z",
        },
      ]),
    ).toMatchObject({
      total: 2,
      successRatePct: 50,
      averageLatencyMs: 1_000,
      byOutcome: { ready: 1, failed: 1 },
      byErrorCode: { UPSTREAM_UNAVAILABLE: 1 },
    });
  });
});
