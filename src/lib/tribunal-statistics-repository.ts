import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  TRIBUNAL_STATISTICS_BUILDER_VERSION,
  TRIBUNAL_STATISTICS_ELIGIBILITY_RULE_VERSION,
  TRIBUNAL_STATISTICS_SMOOTHING_RULE_VERSION,
  tribunalStatisticsItemSchema,
  tribunalStatisticsPayloadSchema,
  tribunalStatisticsResponseSchema,
  tribunalStatisticsWindowMonthsSchema,
  type TribunalStatisticsItem,
  type TribunalStatisticsDistribution,
  type TribunalStatisticsMetric,
  type TribunalStatisticsPayload,
  type TribunalStatisticsReliability,
  type TribunalStatisticsResponse,
  type TribunalStatisticsWindowMonths,
} from "@/lib/tribunal-statistics";

const ROUND_KIND = "initial" as const;
const MAX_TRIBUNAL_SNAPSHOTS = 500;
const EXPERIMENTAL_WARNING =
  "Statistiques expérimentales fondées uniquement sur des résultats judiciaires admissibles et vérifiés.";
const HISTORICAL_LIMITATION =
  "Ces statistiques décrivent un historique et ne prédisent pas l’issue d’une audience individuelle.";
const UNKNOWN_LIMITATION =
  "Une issue inconnue reste hors des dénominateurs connus et n’est jamais assimilée à une absence d’événement.";

const storedIntegerSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/).transform(Number),
]);
const storedProbabilitySchema = z.union([
  z.number().min(0).max(1),
  z
    .string()
    .regex(/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/)
    .transform(Number),
]);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoDateTimeSchema = z.string().datetime({ offset: true });

const storedSnapshotSchema = z
  .object({
    id: z.string().uuid(),
    scope_type: z.enum(["national", "tribunal"]),
    court_id: z.string().uuid().nullable(),
    court_code: z.string().min(1).nullable(),
    court_name: z.string().min(1).nullable(),
    judicial_region: z.string().min(1).nullable(),
    parent_snapshot_id: z.string().uuid().nullable(),
    round_kind: z.enum(["initial", "postponed", "surenchere", "reiteration"]),
    window_months: tribunalStatisticsWindowMonthsSchema,
    period_start: isoDateSchema,
    period_end: isoDateSchema,
    knowledge_cutoff_at: isoDateTimeSchema,
    maturity_days: storedIntegerSchema,
    builder_version: z.literal(TRIBUNAL_STATISTICS_BUILDER_VERSION),
    eligibility_rule_version: z.literal(TRIBUNAL_STATISTICS_ELIGIBILITY_RULE_VERSION),
    smoothing_rule_version: z.literal(TRIBUNAL_STATISTICS_SMOOTHING_RULE_VERSION),
    reliability_status: z.enum(["insufficient_data", "smoothed", "descriptive", "robust"]),
    quality_gate_passed: z.boolean(),
    eligible_round_count: storedIntegerSchema,
    unfrozen_round_count: storedIntegerSchema,
    freeze_coverage: storedProbabilitySchema,
    status_sample_size: storedIntegerSchema,
    initial_price_sample_size: storedIntegerSchema,
    effective_price_sample_size: storedIntegerSchema,
    market_price_sample_size: storedIntegerSchema,
    surenchere_sample_size: storedIntegerSchema,
    result_delay_sample_size: storedIntegerSchema,
    postponement_delay_sample_size: storedIntegerSchema,
    double_reviewed_count: storedIntegerSchema,
    outcome_coverage: storedProbabilitySchema,
    statistics: z.unknown(),
    source_manifest_hash: hashSchema,
    statistics_hash: hashSchema,
    computed_at: isoDateTimeSchema,
  })
  .strict();

export type StoredTribunalStatisticsSnapshot = z.input<typeof storedSnapshotSchema>;
type ParsedStoredTribunalStatisticsSnapshot = z.output<typeof storedSnapshotSchema>;

const courtCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .transform((value) => value.toLocaleLowerCase("fr-FR"))
  .refine((value) => /^[a-z0-9][a-z0-9:._-]*$/.test(value), {
    message: "Code tribunal invalide.",
  });

export const tribunalStatisticsQuerySchema = z
  .object({
    windowMonths: z.preprocess(
      (value) => (value === undefined ? 36 : Number(value)),
      tribunalStatisticsWindowMonthsSchema,
    ),
    courtCode: courtCodeSchema.optional(),
  })
  .strict();

export type TribunalStatisticsQuery = z.infer<typeof tribunalStatisticsQuerySchema>;

type DatabaseError = { message: string };
type DatabaseResult = { data: unknown; error: DatabaseError | null };
type SnapshotQuery = PromiseLike<DatabaseResult> & {
  select(columns: string): SnapshotQuery;
  eq(column: string, value: unknown): SnapshotQuery;
  ilike(column: string, pattern: string): SnapshotQuery;
  order(column: string, options?: { ascending?: boolean }): SnapshotQuery;
  limit(count: number): SnapshotQuery;
  maybeSingle(): PromiseLike<DatabaseResult>;
};
type TribunalStatisticsAdminClient = { from(table: string): SnapshotQuery };

const tribunalStatisticsAdmin = supabaseAdmin as unknown as TribunalStatisticsAdminClient;

const SNAPSHOT_COLUMNS = [
  "id",
  "scope_type",
  "court_id",
  "court_code",
  "court_name",
  "judicial_region",
  "parent_snapshot_id",
  "round_kind",
  "window_months",
  "period_start",
  "period_end",
  "knowledge_cutoff_at",
  "maturity_days",
  "builder_version",
  "eligibility_rule_version",
  "smoothing_rule_version",
  "reliability_status",
  "quality_gate_passed",
  "eligible_round_count",
  "unfrozen_round_count",
  "freeze_coverage",
  "status_sample_size",
  "initial_price_sample_size",
  "effective_price_sample_size",
  "market_price_sample_size",
  "surenchere_sample_size",
  "result_delay_sample_size",
  "postponement_delay_sample_size",
  "double_reviewed_count",
  "outcome_coverage",
  "statistics",
  "source_manifest_hash",
  "statistics_hash",
  "computed_at",
].join(",");

export class TribunalStatisticsUnavailableError extends Error {
  constructor(message = "Tribunal statistics are temporarily unavailable.") {
    super(message);
    this.name = "TribunalStatisticsUnavailableError";
  }
}

export function tribunalStatisticsEnabled(
  value = process.env.TRIBUNAL_STATISTICS_ENABLED,
): boolean {
  return value === "true";
}

export async function getTribunalStatistics(
  input: TribunalStatisticsQuery,
): Promise<TribunalStatisticsResponse> {
  if (!tribunalStatisticsEnabled()) {
    throw new TribunalStatisticsUnavailableError(
      "Configuration: tribunal statistics are disabled.",
    );
  }

  const national = await fetchLatestNationalSnapshot(input.windowMonths);
  if (!national) {
    throw new TribunalStatisticsUnavailableError(
      "No publishable national tribunal-statistics snapshot is available.",
    );
  }

  const tribunalRows = await fetchCompatibleTribunalSnapshots(national, input.courtCode);
  return decodeStoredTribunalStatisticsResponse({ national, tribunals: tribunalRows });
}

export function decodeStoredTribunalStatisticsResponse(input: {
  national: StoredTribunalStatisticsSnapshot;
  tribunals: StoredTribunalStatisticsSnapshot[];
}): TribunalStatisticsResponse {
  try {
    const national = storedSnapshotSchema.parse(input.national);
    const tribunalRows = input.tribunals.map((row) => storedSnapshotSchema.parse(row));
    assertNationalSnapshot(national);

    const seenCourtCodes = new Set<string>();
    for (const tribunal of tribunalRows) {
      assertCompatibleTribunalSnapshot(tribunal, national);
      const courtCode = tribunal.court_code!;
      if (seenCourtCodes.has(courtCode)) {
        throw new Error("A compatible build contains duplicate tribunal snapshots.");
      }
      seenCourtCodes.add(courtCode);
    }

    const nationalPayload = tribunalStatisticsPayloadSchema.parse(national.statistics);
    assertPayloadMatchesSnapshot(nationalPayload, national);
    const nationalItem = decodeSnapshotItem(national, nationalPayload);
    const tribunals = tribunalRows
      .map((row) => {
        const payload = tribunalStatisticsPayloadSchema.parse(row.statistics);
        assertPayloadMatchesSnapshot(payload, row, nationalPayload);
        return decodeSnapshotItem(row, payload);
      })
      .sort((left, right) =>
        left.tribunal!.name.localeCompare(right.tribunal!.name, "fr", {
          sensitivity: "base",
        }),
      );

    return tribunalStatisticsResponseSchema.parse({
      national: nationalItem,
      tribunals,
      meta: {
        generatedAt: national.computed_at,
        experimental: true,
        windowMonths: national.window_months,
        roundKind: ROUND_KIND,
        warnings: uniqueStrings([EXPERIMENTAL_WARNING, ...nationalItem.reliability.warnings]),
      },
    });
  } catch (error) {
    if (error instanceof TribunalStatisticsUnavailableError) throw error;
    throw new TribunalStatisticsUnavailableError(
      "Stored tribunal statistics failed publication validation.",
    );
  }
}

async function fetchLatestNationalSnapshot(
  windowMonths: TribunalStatisticsWindowMonths,
): Promise<ParsedStoredTribunalStatisticsSnapshot | null> {
  const result = await tribunalStatisticsAdmin
    .from("tribunal_statistics_snapshots")
    .select(SNAPSHOT_COLUMNS)
    .eq("scope_type", "national")
    .eq("round_kind", ROUND_KIND)
    .eq("window_months", windowMonths)
    .order("knowledge_cutoff_at", { ascending: false })
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (result.error) {
    throw new TribunalStatisticsUnavailableError(
      "Unable to read the national tribunal-statistics snapshot.",
    );
  }
  if (result.data == null) return null;
  return parseStoredSnapshot(result.data);
}

async function fetchCompatibleTribunalSnapshots(
  national: ParsedStoredTribunalStatisticsSnapshot,
  courtCode?: string,
): Promise<ParsedStoredTribunalStatisticsSnapshot[]> {
  let query = tribunalStatisticsAdmin
    .from("tribunal_statistics_snapshots")
    .select(SNAPSHOT_COLUMNS)
    .eq("scope_type", "tribunal")
    .eq("parent_snapshot_id", national.id)
    .eq("round_kind", ROUND_KIND)
    .eq("window_months", national.window_months);
  // Court codes are supplied by the canonical catalogue and are not guaranteed
  // to use a single case. Escape ILIKE metacharacters so this stays an exact,
  // case-insensitive lookup rather than a user-controlled pattern search.
  if (courtCode) query = query.ilike("court_code", escapeIlikeLiteral(courtCode));

  const result = await query
    .order("court_name", { ascending: true })
    .order("computed_at", { ascending: false })
    .limit(MAX_TRIBUNAL_SNAPSHOTS);
  if (result.error) {
    throw new TribunalStatisticsUnavailableError(
      "Unable to read compatible tribunal-statistics snapshots.",
    );
  }

  if (!Array.isArray(result.data)) {
    throw new TribunalStatisticsUnavailableError(
      "The tribunal-statistics snapshot result is invalid.",
    );
  }
  return result.data.map(parseStoredSnapshot);
}

function parseStoredSnapshot(value: unknown): ParsedStoredTribunalStatisticsSnapshot {
  try {
    return storedSnapshotSchema.parse(value);
  } catch {
    throw new TribunalStatisticsUnavailableError(
      "A stored tribunal-statistics snapshot is invalid.",
    );
  }
}

function decodeSnapshotItem(
  row: ParsedStoredTribunalStatisticsSnapshot,
  payload: TribunalStatisticsPayload,
): TribunalStatisticsItem {
  const publishCount = (count: number): number | null =>
    row.quality_gate_passed && count >= 10 ? count : null;
  const publishedEligibleRounds = publishCount(row.eligible_round_count);
  const publishedStatus = publishCount(row.status_sample_size);

  const reliabilityWarnings = uniqueStrings([
    ...payload.warnings,
    ...(row.reliability_status === "insufficient_data"
      ? ["Échantillon insuffisant : aucune valeur tribunal autonome n’est publiée."]
      : []),
    ...(!row.quality_gate_passed
      ? ["Le contrôle qualité requis pour la publication n’est pas encore franchi."]
      : []),
  ]);

  return tribunalStatisticsItemSchema.parse({
    scope: row.scope_type,
    tribunal:
      row.scope_type === "tribunal"
        ? {
            code: row.court_code,
            name: row.court_name,
            judicialRegion: row.judicial_region,
          }
        : null,
    roundKind: row.round_kind,
    period: {
      start: row.period_start,
      end: row.period_end,
      windowMonths: row.window_months,
      knowledgeCutoffAt: row.knowledge_cutoff_at,
    },
    reliability: {
      level: row.reliability_status,
      label: reliabilityLabel(row.reliability_status),
      qualityGatePassed: row.quality_gate_passed,
      coverage:
        publishedEligibleRounds === null || publishedStatus === null ? null : row.outcome_coverage,
      warnings: reliabilityWarnings,
    },
    samples: {
      eligibleRounds: publishedEligibleRounds,
      status: publishedStatus,
      initialPrice: publishCount(row.initial_price_sample_size),
      effectivePrice: publishCount(row.effective_price_sample_size),
      marketPrice: publishCount(row.market_price_sample_size),
      surenchere: publishCount(row.surenchere_sample_size),
      resultDelay: publishCount(row.result_delay_sample_size),
      postponementDelay: publishCount(row.postponement_delay_sample_size),
      doubleReviewed: publishCount(row.double_reviewed_count),
    },
    flow: payload.flow,
    surenchere: payload.surenchere,
    priceRatios: payload.priceRatios,
    delays: payload.delays,
    fallback: payload.fallback,
    methodology: {
      builderVersion: row.builder_version,
      eligibilityRuleVersion: row.eligibility_rule_version,
      smoothingRuleVersion: row.smoothing_rule_version,
    },
    limitations: uniqueStrings([HISTORICAL_LIMITATION, UNKNOWN_LIMITATION, ...payload.warnings]),
  });
}

function assertNationalSnapshot(row: ParsedStoredTribunalStatisticsSnapshot): void {
  if (
    row.scope_type !== "national" ||
    row.court_id !== null ||
    row.court_code !== null ||
    row.court_name !== null ||
    row.judicial_region !== null ||
    row.parent_snapshot_id !== null ||
    row.round_kind !== ROUND_KIND
  ) {
    throw new Error("The national snapshot scope is invalid.");
  }
}

function assertCompatibleTribunalSnapshot(
  tribunal: ParsedStoredTribunalStatisticsSnapshot,
  national: ParsedStoredTribunalStatisticsSnapshot,
): void {
  if (
    tribunal.scope_type !== "tribunal" ||
    tribunal.court_id === null ||
    tribunal.court_code === null ||
    tribunal.court_name === null ||
    tribunal.parent_snapshot_id !== national.id ||
    tribunal.round_kind !== national.round_kind ||
    tribunal.window_months !== national.window_months ||
    tribunal.period_start !== national.period_start ||
    tribunal.period_end !== national.period_end ||
    Date.parse(tribunal.knowledge_cutoff_at) !== Date.parse(national.knowledge_cutoff_at) ||
    tribunal.maturity_days !== national.maturity_days ||
    tribunal.builder_version !== national.builder_version ||
    tribunal.eligibility_rule_version !== national.eligibility_rule_version ||
    tribunal.smoothing_rule_version !== national.smoothing_rule_version ||
    (tribunal.quality_gate_passed && !national.quality_gate_passed)
  ) {
    throw new Error("A tribunal snapshot is incompatible with its national reference.");
  }
}

function assertPayloadMatchesSnapshot(
  payload: TribunalStatisticsPayload,
  row: ParsedStoredTribunalStatisticsSnapshot,
  parentPayload?: TribunalStatisticsPayload,
): void {
  const flowMetrics = [
    payload.flow.held,
    payload.flow.postponed,
    payload.flow.cancelled,
    payload.flow.notRequested,
  ];
  const suppressedFlowCount = flowMetrics.filter((metric) => metric.method === "suppressed").length;
  if (suppressedFlowCount !== 0 && suppressedFlowCount !== flowMetrics.length) {
    throw new Error("The known audience-flow cells must be published or suppressed together.");
  }
  for (const metric of flowMetrics) {
    if (metric.method === "suppressed") continue;
    if (
      metric.knownDenominator !== row.status_sample_size ||
      metric.eligibleUniverse !== row.eligible_round_count ||
      metric.knownDenominator + metric.unknownCount + metric.excludedCount !==
        metric.eligibleUniverse
    ) {
      throw new Error("A flow denominator does not match its snapshot manifest.");
    }
  }

  if (flowMetrics.every((metric) => metric.method !== "suppressed")) {
    const heldCount = payload.flow.held.numerator;
    if (
      heldCount === null ||
      flowMetrics.reduce((sum, metric) => sum + (metric.numerator ?? 0), 0) !==
        row.status_sample_size
    ) {
      throw new Error("The known audience flow is inconsistent.");
    }
    const heldConditional = [payload.flow.noBidIfHeld, payload.flow.adjudicatedIfHeld];
    const suppressedConditionalCount = heldConditional.filter(
      (metric) => metric.method === "suppressed",
    ).length;
    if (suppressedConditionalCount !== 0 && suppressedConditionalCount !== heldConditional.length) {
      throw new Error("The held-audience conditional cells must be suppressed together.");
    }
    if (
      heldConditional.every((metric) => metric.method !== "suppressed") &&
      (payload.flow.noBidIfHeld.knownDenominator !== heldCount ||
        payload.flow.noBidIfHeld.eligibleUniverse !== heldCount ||
        payload.flow.adjudicatedIfHeld.knownDenominator !== heldCount ||
        payload.flow.adjudicatedIfHeld.eligibleUniverse !== heldCount ||
        payload.flow.noBidIfHeld.numerator! + payload.flow.adjudicatedIfHeld.numerator! !==
          heldCount)
    ) {
      throw new Error("The conditional held-audience flow is inconsistent.");
    }
  }

  const expectedSamples = [
    [
      payload.surenchere.filed.method,
      payload.surenchere.filed.knownDenominator,
      row.surenchere_sample_size,
    ],
    [
      payload.priceRatios.finalToInitial.method,
      payload.priceRatios.finalToInitial.sampleSize,
      row.initial_price_sample_size,
    ],
    [
      payload.priceRatios.finalToEffective.method,
      payload.priceRatios.finalToEffective.sampleSize,
      row.effective_price_sample_size,
    ],
    [
      payload.priceRatios.finalToMarket.method,
      payload.priceRatios.finalToMarket.sampleSize,
      row.market_price_sample_size,
    ],
    [
      payload.delays.hearingToKnownResult.method,
      payload.delays.hearingToKnownResult.sampleSize,
      row.result_delay_sample_size,
    ],
    [
      payload.delays.postponementToNextHearing.method,
      payload.delays.postponementToNextHearing.sampleSize,
      row.postponement_delay_sample_size,
    ],
  ] as const;
  for (const [method, actual, expected] of expectedSamples) {
    if (method !== "suppressed" && actual !== expected) {
      throw new Error("A metric sample size does not match its snapshot manifest.");
    }
  }

  const allCells = [
    ...Object.values(payload.flow),
    payload.surenchere.filed,
    ...Object.values(payload.priceRatios),
    ...Object.values(payload.delays),
  ];
  for (const cell of allCells) {
    if (cell.method !== "suppressed" && cell.eligibleUniverse > row.eligible_round_count) {
      throw new Error("A metric universe exceeds the snapshot universe.");
    }
  }

  const expectedCoverage =
    row.eligible_round_count === 0 ? 0 : row.status_sample_size / row.eligible_round_count;
  if (Math.abs(row.outcome_coverage - expectedCoverage) > 0.000001) {
    throw new Error("The published outcome coverage is inconsistent.");
  }

  const matureRoundCount = row.eligible_round_count + row.unfrozen_round_count;
  const expectedFreezeCoverage =
    matureRoundCount === 0 ? 1 : row.eligible_round_count / matureRoundCount;
  if (Math.abs(row.freeze_coverage - expectedFreezeCoverage) > 0.000001) {
    throw new Error("The private freeze coverage is inconsistent.");
  }
  const freezeGatePassed =
    matureRoundCount === 0 || row.eligible_round_count * 5 >= matureRoundCount * 4;
  if (row.quality_gate_passed && !freezeGatePassed) {
    throw new Error("The snapshot quality gate cannot pass with insufficient freeze coverage.");
  }
  if (row.quality_gate_passed && row.status_sample_size < 10) {
    throw new Error("The snapshot quality gate cannot pass below ten known outcomes.");
  }

  assertReliabilityThreshold(row);
  const minimumDoubleReviews = Math.ceil(Math.min(row.status_sample_size, 500) * 0.2);
  if (row.quality_gate_passed && row.double_reviewed_count < minimumDoubleReviews) {
    throw new Error("The snapshot does not meet the independent double-review threshold.");
  }
  if (!row.quality_gate_passed) assertPayloadSuppressed(payload);
  assertV1Adjustments(payload, row, parentPayload);
  assertV1PublicationCompleteness(payload, row, parentPayload);
  assertFallback(row.scope_type, payload.fallback);
}

function assertV1PublicationCompleteness(
  payload: TribunalStatisticsPayload,
  row: ParsedStoredTribunalStatisticsSnapshot,
  parentPayload?: TribunalStatisticsPayload,
): void {
  if (!row.quality_gate_passed) return;

  for (const metric of [
    payload.flow.held,
    payload.flow.postponed,
    payload.flow.cancelled,
    payload.flow.notRequested,
  ]) {
    assertPublicationState(metric.method, true, "known audience flow");
  }

  const heldCount = payload.flow.held.method === "suppressed" ? 0 : payload.flow.held.numerator;
  assertPublicationState(payload.flow.noBidIfHeld.method, heldCount >= 10, "held no-bid rate");
  assertPublicationState(
    payload.flow.adjudicatedIfHeld.method,
    heldCount >= 10,
    "held adjudication rate",
  );
  assertPublicationState(
    payload.surenchere.filed.method,
    row.surenchere_sample_size >= 10,
    "surenchere rate",
  );

  const distributionShouldPublish = (
    sampleSize: number,
    parent: TribunalStatisticsDistribution | undefined,
  ): boolean =>
    row.scope_type === "national"
      ? sampleSize >= 30
      : sampleSize >= 10 && parent !== undefined && parent.method !== "suppressed";
  assertPublicationState(
    payload.priceRatios.finalToInitial.method,
    distributionShouldPublish(
      row.initial_price_sample_size,
      parentPayload?.priceRatios.finalToInitial,
    ),
    "initial-price distribution",
  );
  assertPublicationState(
    payload.priceRatios.finalToEffective.method,
    distributionShouldPublish(
      row.effective_price_sample_size,
      parentPayload?.priceRatios.finalToEffective,
    ),
    "effective-price distribution",
  );
  assertPublicationState(
    payload.delays.hearingToKnownResult.method,
    distributionShouldPublish(
      row.result_delay_sample_size,
      parentPayload?.delays.hearingToKnownResult,
    ),
    "result-delay distribution",
  );
}

function assertPublicationState(method: string, shouldPublish: boolean, label: string): void {
  if ((method !== "suppressed") !== shouldPublish) {
    throw new Error(`The v1 ${label} publication state is inconsistent.`);
  }
}

function assertV1Adjustments(
  payload: TribunalStatisticsPayload,
  row: ParsedStoredTribunalStatisticsSnapshot,
  parentPayload?: TribunalStatisticsPayload,
): void {
  const parentRates = parentPayload
    ? [
        parentPayload.flow.held,
        parentPayload.flow.postponed,
        parentPayload.flow.cancelled,
        parentPayload.flow.notRequested,
        parentPayload.flow.noBidIfHeld,
        parentPayload.flow.adjudicatedIfHeld,
        parentPayload.surenchere.filed,
      ]
    : [];
  const rates = [
    payload.flow.held,
    payload.flow.postponed,
    payload.flow.cancelled,
    payload.flow.notRequested,
    payload.flow.noBidIfHeld,
    payload.flow.adjudicatedIfHeld,
    payload.surenchere.filed,
  ];
  rates.forEach((metric, index) => assertV1Rate(metric, row.scope_type, parentRates[index]));

  const parentPrices = parentPayload?.priceRatios;
  assertV1Distribution(
    payload.priceRatios.finalToInitial,
    row.scope_type,
    parentPrices?.finalToInitial,
    "log",
  );
  assertV1Distribution(
    payload.priceRatios.finalToEffective,
    row.scope_type,
    parentPrices?.finalToEffective,
    "log",
  );
  if (payload.priceRatios.finalToMarket.method !== "suppressed") {
    throw new Error("The v1 market-price ratio must stay suppressed.");
  }
  assertV1Distribution(
    payload.delays.hearingToKnownResult,
    row.scope_type,
    parentPayload?.delays.hearingToKnownResult,
    "log1p",
  );
  if (payload.delays.postponementToNextHearing.method !== "suppressed") {
    throw new Error("The v1 postponement delay must stay suppressed.");
  }

  if (row.scope_type === "tribunal") {
    if (
      payload.fallback.scope !== "national" ||
      payload.fallback.parentLabel !== "France entière"
    ) {
      throw new Error("A v1 tribunal snapshot must name its national reference.");
    }
    const expectedWeight =
      payload.flow.held.method === "suppressed"
        ? 0
        : roundProbability(
            row.status_sample_size /
              (row.status_sample_size + priorStrength(row.status_sample_size) + 1),
          );
    assertClose(payload.fallback.localWeight, expectedWeight, 1e-9, "local fallback weight");
  }
}

function assertV1Rate(
  metric: TribunalStatisticsMetric,
  scope: "national" | "tribunal",
  parent?: TribunalStatisticsMetric,
): void {
  if (metric.method === "suppressed") return;
  if (metric.method !== "beta_binomial") {
    throw new Error("A published v1 rate must use beta-binomial adjustment.");
  }

  let parentAdjustedValue: number | undefined;
  if (scope === "national") {
    parentAdjustedValue = undefined;
  } else {
    if (!parent || parent.method === "suppressed") {
      throw new Error("A published local v1 rate requires a published national parent.");
    }
    parentAdjustedValue = parent.adjustedValue;
  }

  const expected = tribunalStatisticsV1RateExpectation(
    metric.numerator,
    metric.knownDenominator,
    parentAdjustedValue,
  );
  assertClose(metric.adjustedValue, expected.adjustedValue, 1e-9, "adjusted rate");
  assertClose(metric.confidenceInterval.low, expected.low, 1e-9, "rate interval low");
  assertClose(metric.confidenceInterval.high, expected.high, 1e-9, "rate interval high");
}

export function tribunalStatisticsV1RateExpectation(
  numerator: number,
  denominator: number,
  parentAdjustedValue?: number,
): { adjustedValue: number; low: number; high: number } {
  const strength = parentAdjustedValue === undefined ? 0 : priorStrength(denominator);
  const alpha = numerator + 0.5 + (parentAdjustedValue ?? 0) * strength;
  const beta = denominator - numerator + 0.5 + (1 - (parentAdjustedValue ?? 1)) * strength;
  return {
    adjustedValue: roundProbability(alpha / (alpha + beta)),
    low: roundProbability(betaQuantile(0.025, alpha, beta)),
    high: roundProbability(betaQuantile(0.975, alpha, beta)),
  };
}

function assertV1Distribution(
  distribution: TribunalStatisticsDistribution,
  scope: "national" | "tribunal",
  parent: TribunalStatisticsDistribution | undefined,
  scale: "log" | "log1p",
): void {
  if (distribution.method === "suppressed") return;
  const transform = scale === "log" ? Math.log : Math.log1p;
  const inverse = scale === "log" ? Math.exp : Math.expm1;
  const rawValues = [distribution.raw.p10, distribution.raw.p50, distribution.raw.p90];
  if (scale === "log" && rawValues.some((value) => value <= 0)) {
    throw new Error("A published price-ratio quantile must be strictly positive.");
  }

  let expected: { p10: number; p50: number; p90: number };
  if (scope === "national") {
    if (distribution.parentSampleSize !== 0) {
      throw new Error("A national v1 distribution cannot have a parent sample.");
    }
    if (distribution.sampleSize < 30) {
      throw new Error("A national v1 distribution under 30 observations must be suppressed.");
    }
    if (distribution.sampleSize >= 100) {
      if (distribution.method !== "raw") {
        throw new Error("A large national v1 distribution must be raw.");
      }
      expected = distribution.raw;
    } else {
      if (distribution.method !== "log_shrinkage") {
        throw new Error("A medium national v1 distribution must use log shrinkage.");
      }
      const weight =
        distribution.sampleSize /
        (distribution.sampleSize + priorStrength(distribution.sampleSize));
      const median = transform(distribution.raw.p50);
      expected = inverseQuantiles(
        {
          p10: weight * transform(distribution.raw.p10) + (1 - weight) * median,
          p50: median,
          p90: weight * transform(distribution.raw.p90) + (1 - weight) * median,
        },
        inverse,
      );
    }
  } else {
    if (distribution.method !== "log_shrinkage") {
      throw new Error("A published local v1 distribution must use log shrinkage.");
    }
    if (!parent || parent.method === "suppressed") {
      throw new Error("A published local v1 distribution requires a published national parent.");
    }
    if (distribution.parentSampleSize !== parent.sampleSize) {
      throw new Error("A local v1 distribution must expose the exact national parent sample.");
    }
    const parentAdjusted = parent.adjusted;
    const parentValues = [parentAdjusted.p10, parentAdjusted.p50, parentAdjusted.p90];
    if (scale === "log" && parentValues.some((value) => value <= 0)) {
      throw new Error("A parent price-ratio quantile must be strictly positive.");
    }
    const weight =
      distribution.sampleSize / (distribution.sampleSize + priorStrength(distribution.sampleSize));
    expected = inverseQuantiles(
      {
        p10:
          weight * transform(distribution.raw.p10) + (1 - weight) * transform(parentAdjusted.p10),
        p50:
          weight * transform(distribution.raw.p50) + (1 - weight) * transform(parentAdjusted.p50),
        p90:
          weight * transform(distribution.raw.p90) + (1 - weight) * transform(parentAdjusted.p90),
      },
      inverse,
    );
  }

  assertClose(distribution.adjusted.p10, expected.p10, 1e-6, "adjusted p10");
  assertClose(distribution.adjusted.p50, expected.p50, 1e-6, "adjusted p50");
  assertClose(distribution.adjusted.p90, expected.p90, 1e-6, "adjusted p90");
}

function priorStrength(sampleSize: number): number {
  if (sampleSize < 30) return 30;
  if (sampleSize < 100) return 15;
  return 5;
}

function inverseQuantiles(
  values: { p10: number; p50: number; p90: number },
  inverse: (value: number) => number,
): { p10: number; p50: number; p90: number } {
  return {
    p10: roundTo(Math.max(0, inverse(values.p10)), 6),
    p50: roundTo(Math.max(0, inverse(values.p50)), 6),
    p90: roundTo(Math.max(0, inverse(values.p90)), 6),
  };
}

function roundProbability(value: number): number {
  return roundTo(Math.min(1, Math.max(0, value)), 9);
}

function roundTo(value: number, digits: number): number {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(digits) || digits < 0) {
    throw new Error("Cannot round an invalid published statistic.");
  }

  // PostgreSQL numeric round and Python Decimal(ROUND_HALF_UP) both round a
  // positive decimal tie upward. Multiplying a binary float before Math.round
  // does not preserve that rule (for example 0.0080078125 * 1e9 is represented
  // just below the tie). Parse the shortest canonical decimal representation
  // and round it with integer arithmetic instead.
  const [coefficient, exponentText] = String(value).toLowerCase().split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const [whole, fraction = ""] = coefficient.split(".");
  let unscaled = BigInt(`${whole}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    unscaled *= 10n ** BigInt(-scale);
    scale = 0;
  }

  let rounded: bigint;
  if (scale <= digits) {
    rounded = unscaled * 10n ** BigInt(digits - scale);
  } else {
    const divisor = 10n ** BigInt(scale - digits);
    rounded = unscaled / divisor;
    if ((unscaled % divisor) * 2n >= divisor) rounded += 1n;
  }
  return Number(rounded) / 10 ** digits;
}

function assertClose(actual: number, expected: number, tolerance: number, label: string): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`The ${label} does not match the v1 formula.`);
  }
}

function betaQuantile(probability: number, alpha: number, beta: number): number {
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const middle = (low + high) / 2;
    if (regularizedBeta(middle, alpha, beta) < probability) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

function regularizedBeta(x: number, alpha: number, beta: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logarithm =
    logGamma(alpha + beta) -
    logGamma(alpha) -
    logGamma(beta) +
    alpha * Math.log(x) +
    beta * Math.log1p(-x);
  const factor = Math.exp(logarithm);
  if (x < (alpha + 1) / (alpha + beta + 2)) {
    return (factor * betaContinuedFraction(alpha, beta, x)) / alpha;
  }
  return 1 - (factor * betaContinuedFraction(beta, alpha, 1 - x)) / beta;
}

function betaContinuedFraction(alpha: number, beta: number, x: number): number {
  const epsilon = 3e-14;
  const floor = 1e-300;
  const qab = alpha + beta;
  const qap = alpha + 1;
  const qam = alpha - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  d = Math.abs(d) < floor ? floor : d;
  d = 1 / d;
  let result = d;
  for (let iteration = 1; iteration <= 10_000; iteration += 1) {
    const doubled = 2 * iteration;
    let coefficient = (iteration * (beta - iteration) * x) / ((qam + doubled) * (alpha + doubled));
    d = 1 + coefficient * d;
    d = Math.abs(d) < floor ? floor : d;
    c = 1 + coefficient / c;
    c = Math.abs(c) < floor ? floor : c;
    d = 1 / d;
    result *= d * c;
    coefficient =
      -((alpha + iteration) * (qab + iteration) * x) / ((alpha + doubled) * (qap + doubled));
    d = 1 + coefficient * d;
    d = Math.abs(d) < floor ? floor : d;
    c = 1 + coefficient / c;
    c = Math.abs(c) < floor ? floor : c;
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) < epsilon) return result;
  }
  throw new Error("The beta continued fraction did not converge.");
}

function logGamma(value: number): number {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406,
    12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
  ];
  if (value < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  }
  const shifted = value - 1;
  let series = 0.9999999999998099;
  for (let index = 0; index < coefficients.length; index += 1) {
    series += coefficients[index]! / (shifted + index + 1);
  }
  const t = shifted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(series);
}

function assertPayloadSuppressed(payload: TribunalStatisticsPayload): void {
  const metrics = [...Object.values(payload.flow), payload.surenchere.filed];
  if (
    metrics.some(
      (metric) =>
        metric.method !== "suppressed" ||
        metric.rawValue !== null ||
        metric.adjustedValue !== null ||
        metric.confidenceInterval !== null,
    )
  ) {
    throw new Error("A snapshot that failed quality review cannot expose metric values.");
  }

  const distributions = [...Object.values(payload.priceRatios), ...Object.values(payload.delays)];
  if (
    distributions.some(
      (distribution) =>
        distribution.method !== "suppressed" ||
        distribution.raw !== null ||
        distribution.adjusted !== null,
    )
  ) {
    throw new Error("A snapshot that failed quality review cannot expose distributions.");
  }
}

function assertReliabilityThreshold(row: ParsedStoredTribunalStatisticsSnapshot): void {
  const sampleSize = row.status_sample_size;
  const outcomeCoverageGatePassed =
    row.eligible_round_count > 0 && sampleSize * 5 >= row.eligible_round_count * 4;
  const expected: TribunalStatisticsReliability =
    !row.quality_gate_passed || sampleSize < 10
      ? "insufficient_data"
      : sampleSize < 30
        ? "smoothed"
        : sampleSize < 100 || !outcomeCoverageGatePassed
          ? "descriptive"
          : "robust";
  if (row.reliability_status !== expected) {
    throw new Error("The reliability label does not match the sample-size gate.");
  }
}

function assertFallback(
  scope: "national" | "tribunal",
  fallback: TribunalStatisticsPayload["fallback"],
): void {
  if (fallback.scope === "none" && fallback.parentLabel !== null) {
    throw new Error("A local-only statistic cannot name a fallback parent.");
  }
  if (fallback.scope === "national" && fallback.parentLabel === null) {
    throw new Error("A national fallback must identify its public reference label.");
  }
  if (scope === "national" && (fallback.scope !== "none" || fallback.localWeight !== 1)) {
    throw new Error("The national reference cannot fall back to itself.");
  }
}

function reliabilityLabel(reliability: TribunalStatisticsReliability): string {
  switch (reliability) {
    case "smoothed":
      return "Indicateur fortement lissé";
    case "descriptive":
      return "Statistique descriptive";
    case "robust":
      return "Échantillon potentiellement robuste";
    default:
      return "Données insuffisantes";
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function escapeIlikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
