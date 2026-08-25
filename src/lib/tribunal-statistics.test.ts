import { describe, expect, it } from "vitest";
import {
  tribunalStatisticsItemSchema,
  tribunalStatisticsDistributionSchema,
  tribunalStatisticsMetricSchema,
  tribunalStatisticsPayloadSchema,
  tribunalStatisticsResponseSchema,
  type TribunalStatisticsItem,
} from "@/lib/tribunal-statistics";

const metric = {
  rawValue: 0.6,
  adjustedValue: 0.58,
  numerator: 18,
  knownDenominator: 30,
  eligibleUniverse: 36,
  unknownCount: 6,
  excludedCount: 0,
  exclusionReasons: {},
  confidenceInterval: { low: 0.41, high: 0.75 },
  method: "beta_binomial" as const,
};

const distribution = {
  sampleSize: 30,
  eligibleUniverse: 36,
  unknownCount: 0,
  raw: { p10: 1.1, p50: 1.4, p90: 2.2 },
  adjusted: { p10: 1.12, p50: 1.39, p90: 2.1 },
  method: "log_shrinkage" as const,
  parentSampleSize: 200,
  excludedCount: 6,
  exclusionReasons: { final_hammer_price_claim_ineligible: 6 },
};

function item(scope: "national" | "tribunal"): TribunalStatisticsItem {
  const scopedDistribution = {
    ...distribution,
    method: scope === "national" ? ("raw" as const) : ("log_shrinkage" as const),
    parentSampleSize: scope === "national" ? 0 : 200,
  };
  return {
    scope,
    tribunal:
      scope === "tribunal"
        ? { code: "TJ33063", name: "Tribunal judiciaire de Bordeaux", judicialRegion: null }
        : null,
    roundKind: "initial" as const,
    period: {
      start: "2023-07-01",
      end: "2026-06-30",
      windowMonths: 36 as const,
      knowledgeCutoffAt: "2026-07-31T12:00:00.000Z",
    },
    reliability: {
      level: "descriptive" as const,
      label: "Descriptive",
      qualityGatePassed: true,
      coverage: 30 / 36,
      warnings: [],
    },
    samples: {
      eligibleRounds: 36,
      status: 30,
      initialPrice: 30,
      effectivePrice: 30,
      marketPrice: 30,
      surenchere: 30,
      resultDelay: 30,
      postponementDelay: 30,
      doubleReviewed: null,
    },
    flow: {
      held: metric,
      postponed: metric,
      cancelled: metric,
      notRequested: metric,
      noBidIfHeld: metric,
      adjudicatedIfHeld: metric,
    },
    surenchere: { filed: metric },
    priceRatios: {
      finalToInitial: scopedDistribution,
      finalToEffective: scopedDistribution,
      finalToMarket: scopedDistribution,
    },
    delays: {
      hearingToKnownResult: scopedDistribution,
      postponementToNextHearing: scopedDistribution,
    },
    fallback:
      scope === "national"
        ? { scope: "none" as const, parentLabel: null, localWeight: 1 }
        : { scope: "national" as const, parentLabel: "France entière", localWeight: 0.6 },
    methodology: {
      builderVersion: "tribunal_statistics_builder_v1",
      eligibilityRuleVersion: "claim_ab_reviewed_frozen_round_as_of_v1",
      smoothingRuleVersion: "jeffreys_beta_log_shrinkage_v1",
    },
    limitations: ["Statistique descriptive expérimentale."],
  };
}

describe("tribunal statistics public contract", () => {
  it("accepts a strict national and tribunal response", () => {
    const response = tribunalStatisticsResponseSchema.parse({
      national: item("national"),
      tribunals: [item("tribunal")],
      meta: {
        generatedAt: "2026-07-31T12:00:00.000Z",
        experimental: true,
        windowMonths: 36,
        roundKind: "initial",
        warnings: ["Ne constitue pas une garantie."],
      },
    });

    expect(response.tribunals[0]?.tribunal?.code).toBe("TJ33063");
  });

  it("rejects a numerator above its known denominator", () => {
    expect(() =>
      tribunalStatisticsMetricSchema.parse({
        ...metric,
        numerator: 31,
      }),
    ).toThrow(/numérateur/i);
  });

  it("rejects a raw rate or partition that cannot be reproduced from its counts", () => {
    expect(() =>
      tribunalStatisticsMetricSchema.parse({
        ...metric,
        rawValue: 0.61,
      }),
    ).toThrow(/ratio numérateur/i);

    expect(() =>
      tribunalStatisticsMetricSchema.parse({
        ...metric,
        unknownCount: 5,
      }),
    ).toThrow(/partitionner/i);
  });

  it("keeps rate and distribution adjustment methods type-safe", () => {
    expect(() =>
      tribunalStatisticsMetricSchema.parse({ ...metric, method: "log_shrinkage" }),
    ).toThrow();

    expect(() =>
      tribunalStatisticsItemSchema.parse({
        ...item("national"),
        priceRatios: {
          ...item("national").priceRatios,
          finalToInitial: { ...distribution, method: "beta_binomial" },
        },
      }),
    ).toThrow();
  });

  it("suppresses all autonomous values below ten observations", () => {
    const suppressed = {
      rawValue: null,
      adjustedValue: null,
      numerator: null,
      knownDenominator: null,
      eligibleUniverse: null,
      unknownCount: null,
      excludedCount: null,
      exclusionReasons: {},
      method: "suppressed" as const,
      confidenceInterval: null,
    };

    expect(tribunalStatisticsMetricSchema.parse(suppressed).adjustedValue).toBeNull();

    expect(() =>
      tribunalStatisticsMetricSchema.parse({
        ...suppressed,
        numerator: 4,
      }),
    ).toThrow();
  });

  it("rejects a court identity on the national scope", () => {
    expect(() =>
      tribunalStatisticsItemSchema.parse({
        ...item("national"),
        tribunal: { code: "TJ33063", name: "Bordeaux", judicialRegion: null },
      }),
    ).toThrow(/national/i);
  });

  it("rejects tribunal snapshots built with a different cutoff from the national reference", () => {
    const tribunal = item("tribunal");
    tribunal.period.knowledgeCutoffAt = "2026-07-30T12:00:00.000Z";

    expect(() =>
      tribunalStatisticsResponseSchema.parse({
        national: item("national"),
        tribunals: [tribunal],
        meta: {
          generatedAt: "2026-07-31T12:00:00.000Z",
          experimental: true,
          windowMonths: 36,
          roundKind: "initial",
          warnings: [],
        },
      }),
    ).toThrow(/knowledgeCutoffAt/i);
  });

  it("fails closed on an unknown builder version", () => {
    const national = item("national");

    expect(() =>
      tribunalStatisticsItemSchema.parse({
        ...national,
        methodology: {
          ...national.methodology,
          builderVersion: "tribunal_statistics_builder_v2",
        },
      }),
    ).toThrow();
  });

  it("does not expose values when the human-review quality gate failed", () => {
    const baseline = item("tribunal");
    const rejected = {
      ...baseline,
      reliability: {
        ...baseline.reliability,
        qualityGatePassed: false,
        level: "insufficient_data" as const,
      },
    };

    expect(() => tribunalStatisticsItemSchema.parse(rejected)).toThrow(
      /supprimer toutes les valeurs/i,
    );
  });

  it("rejects a metric sample larger than the verified status population", () => {
    const invalid = item("tribunal");
    invalid.samples.resultDelay = 31;

    expect(() => tribunalStatisticsItemSchema.parse(invalid)).toThrow(/sous-échantillon/i);
  });

  it("requires at least 80 percent coverage before calling a large sample robust", () => {
    const lowCoverage = item("tribunal");
    lowCoverage.samples.eligibleRounds = 126;
    lowCoverage.samples.status = 100;
    lowCoverage.samples.doubleReviewed = 20;
    lowCoverage.reliability.coverage = 100 / 126;
    lowCoverage.reliability.level = "robust";

    expect(() => tribunalStatisticsItemSchema.parse(lowCoverage)).toThrow(/niveau de fiabilité/i);

    lowCoverage.reliability.level = "descriptive";
    expect(tribunalStatisticsItemSchema.parse(lowCoverage).reliability.level).toBe("descriptive");
  });

  it("rejects dynamic stored warnings that could leak a small exact count", () => {
    const baseline = item("national");

    expect(() =>
      tribunalStatisticsPayloadSchema.parse({
        flow: baseline.flow,
        surenchere: baseline.surenchere,
        priceRatios: baseline.priceRatios,
        delays: baseline.delays,
        fallback: baseline.fallback,
        warnings: ["round_not_frozen_at_cutoff: 3"],
      }),
    ).toThrow();
  });

  it("rejects UUID-like exclusion keys outside the exact public v1 allowlist", () => {
    const injectedKey = "b2a68f98-c8b8-4f50-a808-18607b442ee6";

    expect(() =>
      tribunalStatisticsMetricSchema.parse({
        ...metric,
        eligibleUniverse: 36,
        unknownCount: 5,
        excludedCount: 1,
        exclusionReasons: { [injectedKey]: 1 },
      }),
    ).toThrow(/motif d.exclusion/i);

    expect(() =>
      tribunalStatisticsDistributionSchema.parse({
        ...distribution,
        exclusionReasons: { [injectedKey]: 6 },
      }),
    ).toThrow(/motif d.exclusion/i);
  });
});
