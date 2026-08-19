import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TribunalStatisticsPayload } from "@/lib/tribunal-statistics";

const { serverFrom } = vi.hoisted(() => ({ serverFrom: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: serverFrom },
}));

import {
  decodeStoredTribunalStatisticsResponse,
  getTribunalStatistics,
  tribunalStatisticsV1RateExpectation,
  tribunalStatisticsEnabled,
  tribunalStatisticsQuerySchema,
  type StoredTribunalStatisticsSnapshot,
} from "@/lib/tribunal-statistics-repository";

const NATIONAL_ID = "11111111-1111-4111-8111-111111111111";
const COURT_ID = "22222222-2222-4222-8222-222222222222";
const TRIBUNAL_ID = "33333333-3333-4333-8333-333333333333";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("tribunal statistics repository", () => {
  const previousFlag = process.env.TRIBUNAL_STATISTICS_ENABLED;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TRIBUNAL_STATISTICS_ENABLED = "true";
  });

  afterEach(() => {
    if (previousFlag === undefined) delete process.env.TRIBUNAL_STATISTICS_ENABLED;
    else process.env.TRIBUNAL_STATISTICS_ENABLED = previousFlag;
  });

  it("n’active le service que pour la valeur exacte true", () => {
    expect(tribunalStatisticsEnabled("true")).toBe(true);
    expect(tribunalStatisticsEnabled("TRUE")).toBe(false);
    expect(tribunalStatisticsEnabled("1")).toBe(false);
    expect(tribunalStatisticsEnabled("")).toBe(false);
  });

  it("utilise l’arrondi décimal half-up et converge sur une grande cohorte valide", () => {
    expect(tribunalStatisticsV1RateExpectation(20, 2_559).adjustedValue).toBe(0.008007813);

    const large = tribunalStatisticsV1RateExpectation(62_500, 125_000);
    expect(large.low).toBeLessThan(0.5);
    expect(large.high).toBeGreaterThan(0.5);
  });

  it("normalise et valide une fenêtre fermée et un code tribunal sûr", () => {
    expect(tribunalStatisticsQuerySchema.parse({})).toEqual({ windowMonths: 36 });
    expect(
      tribunalStatisticsQuerySchema.parse({ windowMonths: "12", courtCode: " Bordeaux " }),
    ).toEqual({ windowMonths: 12, courtCode: "bordeaux" });
    expect(() => tribunalStatisticsQuerySchema.parse({ windowMonths: "18" })).toThrow();
    expect(() =>
      tribunalStatisticsQuerySchema.parse({ windowMonths: "36", courtCode: "bordeaux,paris" }),
    ).toThrow();
    expect(() => tribunalStatisticsQuerySchema.parse({ extra: "ignored" })).toThrow();
  });

  it("échappe les métacaractères ILIKE dans un code tribunal canonique", async () => {
    const nationalQuery = fakeQuery({ data: snapshot(), error: null });
    const tribunalsQuery = fakeQuery({ data: [], error: null });
    serverFrom.mockReturnValueOnce(nationalQuery.query).mockReturnValueOnce(tribunalsQuery.query);

    await getTribunalStatistics({ windowMonths: 36, courtCode: "tj_test" });

    expect(tribunalsQuery.state.filters).toContainEqual(["court_code", "tj\\_test"]);
  });

  it("bloque avant toute lecture lorsque le kill switch est fermé", async () => {
    process.env.TRIBUNAL_STATISTICS_ENABLED = "false";

    await expect(getTribunalStatistics({ windowMonths: 36 })).rejects.toThrow(
      "tribunal statistics are disabled",
    );
    expect(serverFrom).not.toHaveBeenCalled();
  });

  it("lit uniquement le dernier national puis ses tribunaux enfants compatibles", async () => {
    const national = snapshot();
    const bordeaux = snapshot({
      id: TRIBUNAL_ID,
      scope_type: "tribunal",
      court_id: COURT_ID,
      court_code: "bordeaux",
      court_name: "Tribunal judiciaire de Bordeaux",
      judicial_region: "Cour d’appel de Bordeaux",
      parent_snapshot_id: NATIONAL_ID,
      statistics: payload({
        scope: "tribunal",
        eligibleRounds: 25,
        statusSample: 20,
        initialPriceSample: 12,
        effectivePriceSample: 10,
        surenchereSample: 10,
        resultDelaySample: 11,
      }),
      reliability_status: "smoothed",
      eligible_round_count: 25,
      status_sample_size: 20,
      initial_price_sample_size: 12,
      effective_price_sample_size: 10,
      surenchere_sample_size: 10,
      result_delay_sample_size: 11,
      double_reviewed_count: 4,
      outcome_coverage: 0.8,
      source_manifest_hash: HASH_B,
      statistics_hash: HASH_B,
    });
    const nationalQuery = fakeQuery({ data: national, error: null });
    const tribunalsQuery = fakeQuery({ data: [bordeaux], error: null });
    serverFrom.mockReturnValueOnce(nationalQuery.query).mockReturnValueOnce(tribunalsQuery.query);

    const response = await getTribunalStatistics({
      windowMonths: 36,
      courtCode: "bordeaux",
    });

    expect(response.national).toMatchObject({
      scope: "national",
      reliability: { level: "robust", label: "Échantillon potentiellement robuste" },
    });
    expect(response.tribunals).toHaveLength(1);
    expect(response.tribunals[0]).toMatchObject({
      scope: "tribunal",
      tribunal: { code: "bordeaux", name: "Tribunal judiciaire de Bordeaux" },
      reliability: { level: "smoothed", coverage: 0.8 },
    });
    expect(response.meta).toMatchObject({
      experimental: true,
      windowMonths: 36,
      roundKind: "initial",
    });

    expect(serverFrom).toHaveBeenNthCalledWith(1, "tribunal_statistics_snapshots");
    expect(serverFrom).toHaveBeenNthCalledWith(2, "tribunal_statistics_snapshots");
    expect(nationalQuery.state.filters).toEqual(
      expect.arrayContaining([
        ["scope_type", "national"],
        ["round_kind", "initial"],
        ["window_months", 36],
      ]),
    );
    expect(tribunalsQuery.state.filters).toEqual(
      expect.arrayContaining([
        ["scope_type", "tribunal"],
        ["parent_snapshot_id", NATIONAL_ID],
        ["court_code", "bordeaux"],
      ]),
    );
    expect(nationalQuery.state.selected).toContain("statistics");
    expect(nationalQuery.state.selected).not.toMatch(/member|evidence|outcome_id|raw_artifact/i);
    expect(JSON.stringify(response)).not.toMatch(
      new RegExp(`${NATIONAL_ID}|${TRIBUNAL_ID}|${COURT_ID}`),
    );
  });

  it("refuse un enfant dont la période diffère de la référence nationale", () => {
    const national = snapshot();
    const tribunal = snapshot({
      id: TRIBUNAL_ID,
      scope_type: "tribunal",
      court_id: COURT_ID,
      court_code: "bordeaux",
      court_name: "Tribunal judiciaire de Bordeaux",
      parent_snapshot_id: NATIONAL_ID,
      period_end: "2026-04-30",
    });

    expect(() =>
      decodeStoredTribunalStatisticsResponse({ national, tribunals: [tribunal] }),
    ).toThrow("failed publication validation");
  });

  it("refuse un JSON agrégé contenant un champ brut inattendu", () => {
    const national = snapshot({
      statistics: { ...payload(), rawDecisionText: "contenu judiciaire brut" },
    });

    expect(() => decodeStoredTribunalStatisticsResponse({ national, tribunals: [] })).toThrow(
      "failed publication validation",
    );
  });

  it("refuse des dénominateurs qui ne correspondent pas au manifeste du snapshot", () => {
    const invalidPayload = payload();
    invalidPayload.flow.held.knownDenominator = 99;
    const national = snapshot({ statistics: invalidPayload });

    expect(() => decodeStoredTribunalStatisticsResponse({ national, tribunals: [] })).toThrow(
      "failed publication validation",
    );
  });

  it("ne publie aucune valeur lorsque le contrôle qualité global a échoué", () => {
    const national = snapshot({
      quality_gate_passed: false,
      reliability_status: "insufficient_data",
    });

    expect(() => decodeStoredTribunalStatisticsResponse({ national, tribunals: [] })).toThrow(
      "failed publication validation",
    );
  });

  it("sert un snapshot QA échoué uniquement après redaction intégrale", () => {
    const national = snapshot({
      quality_gate_passed: false,
      reliability_status: "insufficient_data",
      statistics: suppressedPayload(),
    });

    const response = decodeStoredTribunalStatisticsResponse({ national, tribunals: [] });

    expect(response.national.reliability.coverage).toBeNull();
    expect(Object.values(response.national.samples).every((value) => value === null)).toBe(true);
    expect(response.national.flow.held).toMatchObject({
      method: "suppressed",
      numerator: null,
      knownDenominator: null,
      eligibleUniverse: null,
    });
  });

  it("refuse un univers métrique supérieur à l’univers du snapshot", () => {
    const invalidPayload = payload();
    const ratio = invalidPayload.priceRatios.finalToInitial;
    if (ratio.method === "suppressed") throw new Error("Fixture ratio must be publishable.");
    invalidPayload.priceRatios.finalToInitial = {
      ...ratio,
      eligibleUniverse: 126,
      unknownCount: 76,
    };

    expect(() =>
      decodeStoredTribunalStatisticsResponse({
        national: snapshot({ statistics: invalidPayload }),
        tribunals: [],
      }),
    ).toThrow("failed publication validation");
  });

  it("refuse un quality gate positif lorsque moins de 80 % des audiences ont été gelées", () => {
    const national = snapshot({
      unfrozen_round_count: 32,
      freeze_coverage: 125 / 157,
    });

    expect(() => decodeStoredTribunalStatisticsResponse({ national, tribunals: [] })).toThrow(
      "failed publication validation",
    );
  });

  it("recalcule les ajustements et intervalles publiés au lieu de leur faire confiance", () => {
    const adjustedPayload = payload();
    const adjustedHeld = adjustedPayload.flow.held;
    if (adjustedHeld.method === "suppressed") throw new Error("Fixture rate must be publishable.");
    adjustedPayload.flow.held = {
      ...adjustedHeld,
      adjustedValue: adjustedHeld.adjustedValue + 0.000001,
    };

    const intervalPayload = payload();
    const intervalHeld = intervalPayload.flow.held;
    if (intervalHeld.method === "suppressed") throw new Error("Fixture rate must be publishable.");
    intervalPayload.flow.held = {
      ...intervalHeld,
      confidenceInterval: {
        ...intervalHeld.confidenceInterval,
        high: intervalHeld.confidenceInterval.high + 0.000001,
      },
    };

    expect(() =>
      decodeStoredTribunalStatisticsResponse({
        national: snapshot({ statistics: adjustedPayload }),
        tribunals: [],
      }),
    ).toThrow("failed publication validation");
    expect(() =>
      decodeStoredTribunalStatisticsResponse({
        national: snapshot({ statistics: intervalPayload }),
        tribunals: [],
      }),
    ).toThrow("failed publication validation");
  });

  it("refuse un échantillon parent ou un poids local falsifié", () => {
    const national = snapshot();
    const wrongParentPayload = payload({
      scope: "tribunal",
      eligibleRounds: 25,
      statusSample: 20,
      initialPriceSample: 12,
      effectivePriceSample: 10,
      surenchereSample: 10,
      resultDelaySample: 11,
    });
    const initialRatio = wrongParentPayload.priceRatios.finalToInitial;
    if (initialRatio.method === "suppressed") {
      throw new Error("Fixture distribution must be publishable.");
    }
    wrongParentPayload.priceRatios.finalToInitial = {
      ...initialRatio,
      parentSampleSize: initialRatio.parentSampleSize + 1,
    };

    const wrongWeightPayload = structuredClone(wrongParentPayload);
    wrongWeightPayload.priceRatios.finalToInitial = initialRatio;
    wrongWeightPayload.fallback.localWeight += 0.000001;

    expect(() =>
      decodeStoredTribunalStatisticsResponse({
        national,
        tribunals: [tribunalSnapshot(wrongParentPayload)],
      }),
    ).toThrow("failed publication validation");
    expect(() =>
      decodeStoredTribunalStatisticsResponse({
        national,
        tribunals: [tribunalSnapshot(wrongWeightPayload)],
      }),
    ).toThrow("failed publication validation");
  });

  it("interdit une publication locale si la référence nationale a échoué sa QA", () => {
    const national = snapshot({
      quality_gate_passed: false,
      reliability_status: "insufficient_data",
      statistics: suppressedPayload(),
    });
    const localPayload = suppressedPayload();
    localPayload.fallback = {
      scope: "national",
      parentLabel: "France entière",
      localWeight: 0,
    };
    localPayload.warnings.push(
      "Référence nationale non publiable: toutes les valeurs locales sont masquées.",
    );

    expect(() =>
      decodeStoredTribunalStatisticsResponse({
        national,
        tribunals: [tribunalSnapshot(localPayload)],
      }),
    ).toThrow("failed publication validation");
  });

  it("refuse la suppression sélective d’une cellule pourtant publiable", () => {
    const suppressed = suppressedPayload();
    const hiddenFlow = payload();
    hiddenFlow.flow = suppressed.flow;

    const hiddenDistribution = payload();
    hiddenDistribution.priceRatios.finalToInitial = suppressed.priceRatios.finalToInitial;

    expect(() =>
      decodeStoredTribunalStatisticsResponse({
        national: snapshot({ statistics: hiddenFlow }),
        tribunals: [],
      }),
    ).toThrow("failed publication validation");
    expect(() =>
      decodeStoredTribunalStatisticsResponse({
        national: snapshot({ statistics: hiddenDistribution }),
        tribunals: [],
      }),
    ).toThrow("failed publication validation");
  });
});

function suppressedPayload(): TribunalStatisticsPayload {
  const metric = {
    rawValue: null,
    adjustedValue: null,
    numerator: null,
    knownDenominator: null,
    eligibleUniverse: null,
    unknownCount: null,
    excludedCount: null,
    exclusionReasons: {},
    confidenceInterval: null,
    method: "suppressed" as const,
  };
  const distribution = {
    sampleSize: null,
    eligibleUniverse: null,
    unknownCount: null,
    raw: null,
    adjusted: null,
    method: "suppressed" as const,
    parentSampleSize: null,
    excludedCount: null,
    exclusionReasons: {},
  };
  return {
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
      finalToInitial: distribution,
      finalToEffective: distribution,
      finalToMarket: distribution,
    },
    delays: {
      hearingToKnownResult: distribution,
      postponementToNextHearing: distribution,
    },
    fallback: { scope: "none", parentLabel: null, localWeight: 1 },
    warnings: [
      "Contrôle qualité non atteint: 20 % des 500 premiers résultats vérifiés doivent être relus indépendamment.",
    ],
  };
}

function snapshot(
  overrides: Partial<StoredTribunalStatisticsSnapshot> = {},
): StoredTribunalStatisticsSnapshot {
  return {
    id: NATIONAL_ID,
    scope_type: "national",
    court_id: null,
    court_code: null,
    court_name: null,
    judicial_region: null,
    parent_snapshot_id: null,
    round_kind: "initial",
    window_months: 36,
    period_start: "2023-06-01",
    period_end: "2026-05-31",
    knowledge_cutoff_at: "2026-06-30T23:59:59.000Z",
    maturity_days: 30,
    builder_version: "tribunal_statistics_builder_v1",
    eligibility_rule_version: "claim_ab_reviewed_frozen_round_as_of_v1",
    smoothing_rule_version: "jeffreys_beta_log_shrinkage_v1",
    reliability_status: "robust",
    quality_gate_passed: true,
    eligible_round_count: 125,
    unfrozen_round_count: 0,
    freeze_coverage: 1,
    status_sample_size: 100,
    initial_price_sample_size: 50,
    effective_price_sample_size: 45,
    market_price_sample_size: 0,
    surenchere_sample_size: 40,
    result_delay_sample_size: 70,
    postponement_delay_sample_size: 0,
    double_reviewed_count: 20,
    outcome_coverage: 0.8,
    statistics: payload(),
    source_manifest_hash: HASH_A,
    statistics_hash: HASH_A,
    computed_at: "2026-07-01T01:00:00.000Z",
    ...overrides,
  };
}

function tribunalSnapshot(statistics: TribunalStatisticsPayload): StoredTribunalStatisticsSnapshot {
  return snapshot({
    id: TRIBUNAL_ID,
    scope_type: "tribunal",
    court_id: COURT_ID,
    court_code: "bordeaux",
    court_name: "Tribunal judiciaire de Bordeaux",
    judicial_region: "Cour d’appel de Bordeaux",
    parent_snapshot_id: NATIONAL_ID,
    reliability_status: "smoothed",
    eligible_round_count: 25,
    status_sample_size: 20,
    initial_price_sample_size: 12,
    effective_price_sample_size: 10,
    surenchere_sample_size: 10,
    result_delay_sample_size: 11,
    double_reviewed_count: 4,
    outcome_coverage: 0.8,
    statistics,
    source_manifest_hash: HASH_B,
    statistics_hash: HASH_B,
  });
}

function payload(
  options: {
    scope?: "national" | "tribunal";
    eligibleRounds?: number;
    statusSample?: number;
    initialPriceSample?: number;
    effectivePriceSample?: number;
    surenchereSample?: number;
    resultDelaySample?: number;
  } = {},
): TribunalStatisticsPayload {
  const scope = options.scope ?? "national";
  const eligibleRounds = options.eligibleRounds ?? 125;
  const statusSample = options.statusSample ?? 100;
  const initialPriceSample = options.initialPriceSample ?? 50;
  const effectivePriceSample = options.effectivePriceSample ?? 45;
  const surenchereSample = options.surenchereSample ?? 40;
  const resultDelaySample = options.resultDelaySample ?? 70;
  const unknown = eligibleRounds - statusSample;
  const held = Math.floor(statusSample * 0.6);
  const postponed = Math.floor(statusSample * 0.2);
  const cancelled = Math.floor(statusSample * 0.1);
  const notRequested = statusSample - held - postponed - cancelled;
  const noBid = Math.floor(held * 0.2);
  const parent = scope === "tribunal" ? payload() : undefined;

  const flowMetric = (
    numerator: number,
    denominator: number,
    universe: number,
    unknownCount: number,
    parentMetric?: TribunalStatisticsPayload["flow"]["held"],
  ) => {
    const expected = tribunalStatisticsV1RateExpectation(
      numerator,
      denominator,
      parentMetric?.method === "suppressed" ? undefined : parentMetric?.adjustedValue,
    );
    return {
      rawValue: numerator / denominator,
      adjustedValue: expected.adjustedValue,
      numerator,
      knownDenominator: denominator,
      eligibleUniverse: universe,
      unknownCount,
      excludedCount: 0,
      exclusionReasons: {},
      confidenceInterval: { low: expected.low, high: expected.high },
      method: "beta_binomial" as const,
    };
  };
  const distribution = (
    sampleSize: number,
    raw: { p10: number; p50: number; p90: number },
    parentDistribution: TribunalStatisticsPayload["priceRatios"]["finalToInitial"] | undefined,
    scale: "log" | "log1p",
  ) => {
    const transform = scale === "log" ? Math.log : Math.log1p;
    const inverse = scale === "log" ? Math.exp : Math.expm1;
    const strength = sampleSize < 30 ? 30 : sampleSize < 100 ? 15 : 5;
    const weight = sampleSize / (sampleSize + strength);
    let adjusted = raw;
    let method: "raw" | "log_shrinkage" = "raw";
    let parentSampleSize = 0;
    if (scope === "tribunal") {
      if (!parentDistribution || parentDistribution.method === "suppressed") {
        throw new Error("Fixture requires a published parent distribution.");
      }
      method = "log_shrinkage";
      parentSampleSize = parentDistribution.sampleSize;
      adjusted = mapQuantiles(raw, (key, value) =>
        round6(
          inverse(
            weight * transform(value) + (1 - weight) * transform(parentDistribution.adjusted[key]),
          ),
        ),
      );
    } else if (sampleSize < 100) {
      method = "log_shrinkage";
      const median = transform(raw.p50);
      adjusted = mapQuantiles(raw, (key, value) =>
        round6(inverse(key === "p50" ? median : weight * transform(value) + (1 - weight) * median)),
      );
    }
    return {
      sampleSize,
      eligibleUniverse: sampleSize,
      unknownCount: 0,
      raw,
      adjusted,
      method,
      parentSampleSize,
      excludedCount: 0,
      exclusionReasons: {},
    };
  };
  const suppressedDistribution = {
    sampleSize: null,
    eligibleUniverse: null,
    unknownCount: null,
    raw: null,
    adjusted: null,
    method: "suppressed" as const,
    parentSampleSize: null,
    excludedCount: null,
    exclusionReasons: {},
  };

  return {
    flow: {
      held: flowMetric(held, statusSample, eligibleRounds, unknown, parent?.flow.held),
      postponed: flowMetric(
        postponed,
        statusSample,
        eligibleRounds,
        unknown,
        parent?.flow.postponed,
      ),
      cancelled: flowMetric(
        cancelled,
        statusSample,
        eligibleRounds,
        unknown,
        parent?.flow.cancelled,
      ),
      notRequested: flowMetric(
        notRequested,
        statusSample,
        eligibleRounds,
        unknown,
        parent?.flow.notRequested,
      ),
      noBidIfHeld: flowMetric(noBid, held, held, 0, parent?.flow.noBidIfHeld),
      adjudicatedIfHeld: flowMetric(held - noBid, held, held, 0, parent?.flow.adjudicatedIfHeld),
    },
    surenchere: {
      filed: flowMetric(
        Math.floor(surenchereSample * 0.1),
        surenchereSample,
        surenchereSample,
        0,
        parent?.surenchere.filed,
      ),
    },
    priceRatios: {
      finalToInitial: distribution(
        initialPriceSample,
        { p10: 1.05, p50: 1.4, p90: 2.1 },
        parent?.priceRatios.finalToInitial,
        "log",
      ),
      finalToEffective: distribution(
        effectivePriceSample,
        { p10: 1.05, p50: 1.4, p90: 2.1 },
        parent?.priceRatios.finalToEffective,
        "log",
      ),
      finalToMarket: suppressedDistribution,
    },
    delays: {
      hearingToKnownResult: distribution(
        resultDelaySample,
        { p10: 1, p50: 4, p90: 12 },
        parent?.delays.hearingToKnownResult,
        "log1p",
      ),
      postponementToNextHearing: suppressedDistribution,
    },
    fallback:
      scope === "national"
        ? { scope: "none", parentLabel: null, localWeight: 1 }
        : {
            scope: "national",
            parentLabel: "France entière",
            localWeight: Math.round((statusSample / (statusSample + 30 + 1)) * 1e9) / 1e9,
          },
    warnings: ["Statistiques descriptives historiques, pas une prédiction individuelle."],
  };
}

function mapQuantiles(
  values: { p10: number; p50: number; p90: number },
  map: (key: "p10" | "p50" | "p90", value: number) => number,
) {
  return {
    p10: map("p10", values.p10),
    p50: map("p50", values.p50),
    p90: map("p90", values.p90),
  };
}

function round6(value: number): number {
  return Math.round(Math.max(0, value) * 1e6) / 1e6;
}

function fakeQuery(result: { data: unknown; error: { message: string } | null }) {
  const state: {
    selected: string;
    filters: Array<[string, unknown]>;
    orders: Array<[string, { ascending?: boolean } | undefined]>;
    limit: number | null;
  } = { selected: "", filters: [], orders: [], limit: null };
  const query: Record<string, unknown> = {};
  query.select = vi.fn((columns: string) => {
    state.selected = columns;
    return query;
  });
  query.eq = vi.fn((column: string, value: unknown) => {
    state.filters.push([column, value]);
    return query;
  });
  query.ilike = vi.fn((column: string, value: unknown) => {
    state.filters.push([column, value]);
    return query;
  });
  query.order = vi.fn((column: string, options?: { ascending?: boolean }) => {
    state.orders.push([column, options]);
    return query;
  });
  query.limit = vi.fn((count: number) => {
    state.limit = count;
    return query;
  });
  query.maybeSingle = vi.fn(async () => result);
  query.then = (resolve: (value: typeof result) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return { query, state };
}
