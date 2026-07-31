import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  buildOutcomeGraphRefusal,
  type OutcomeGraphConfidenceLabel,
  type OutcomeGraphForecast,
  type OutcomeGraphHorizon,
  type OutcomeGraphPressureComponent,
  type OutcomeGraphProbability,
  type OutcomeGraphQuantiles,
} from "@/lib/outcome-graph";

const horizonSchema = z.enum(["T-30", "T-14", "T-7", "T-1", "T-2h"]);
const cohortLevelSchema = z.enum([
  "tribunal_procedure_type_occupation_discount",
  "tribunal_procedure_type",
  "region_procedure_type",
  "national_procedure_type",
  "national_property_type",
  "national",
]);
const FORECASTABLE_ROUND_STATUSES = new Set([
  "scheduled",
  "confirmed",
  "surenchere_round_scheduled",
  "reiteration_round_scheduled",
]);
const storedMoneySchema = z.union([z.string(), z.number()]).nullable();

const lotSchema = z.object({
  id: z.string().uuid(),
  active: z.boolean(),
  initial_starting_price_eur: storedMoneySchema,
});

const roundSchema = z.object({
  id: z.string().uuid(),
  lot_id: z.string().uuid(),
  sequence_number: z.number().int().positive(),
  scheduled_at: z.string().nullable(),
  current_status: z.string().min(1),
  initial_starting_price_eur: storedMoneySchema,
  effective_starting_price_eur: storedMoneySchema,
});

const predictionSchema = z.object({
  id: z.string().uuid(),
  round_id: z.string().uuid(),
  snapshot_id: z.string().uuid(),
  model_version_id: z.string().uuid(),
  cohort_statistics_id: z.string().uuid().nullable(),
  prediction_status: z.enum(["ready", "insufficient_data"]),
  generated_at: z.string(),
  created_at: z.string(),
  horizon: horizonSchema,
  probabilities: z.unknown(),
  quantiles: z.unknown(),
  confidence_level: z.union([z.string(), z.number()]).nullable(),
  confidence_label: z.string().nullable(),
  sample_size: z.number().int().nonnegative().nullable(),
  explanation_factors: z.unknown(),
  limitations: z.unknown(),
  refusal_reason: z.string().nullable(),
});

const snapshotSchema = z.object({
  id: z.string().uuid(),
  lot_id: z.string().uuid(),
  round_id: z.string().uuid(),
  prediction_horizon: horizonSchema,
  feature_cutoff_at: z.string(),
  built_at: z.string(),
  feature_schema_version: z.string().min(1),
  leakage_check_status: z.enum(["pending", "passed", "failed"]),
  retrospective: z.boolean(),
  features: z.unknown(),
});

const modelSchema = z.object({
  id: z.string().uuid(),
  model_key: z.string().min(1),
  version: z.string().min(1),
  status: z.enum(["draft", "validated", "shadow", "active", "retired", "rejected"]),
  feature_schema_version: z.string().min(1),
  training_cutoff_at: z.string().nullable(),
  approved_at: z.string().nullable(),
  created_at: z.string(),
});

const cohortStatisticsSchema = z.object({
  id: z.string().uuid(),
  cohort_definition_id: z.string().uuid(),
  prediction_horizon: horizonSchema,
  period_start: z.string(),
  period_end: z.string(),
  sample_size: z.number().int().nonnegative(),
  tribunal_sample_size: z.number().int().nonnegative(),
  training_eligible: z.boolean(),
  has_blocking_conflict: z.boolean(),
  created_at: z.string(),
});

const cohortDefinitionSchema = z.object({
  id: z.string().uuid(),
  cohort_level: cohortLevelSchema,
  label: z.string().min(1),
});

export type StoredOutcomeGraphRecord = {
  lot: z.infer<typeof lotSchema>;
  round: z.infer<typeof roundSchema>;
  prediction: z.infer<typeof predictionSchema> | null;
  snapshot: z.infer<typeof snapshotSchema> | null;
  model: z.infer<typeof modelSchema> | null;
  cohortStatistics: z.infer<typeof cohortStatisticsSchema> | null;
  cohortDefinition: z.infer<typeof cohortDefinitionSchema> | null;
};

type DatabaseError = { code?: string; message: string };
type DatabaseResult = { data: unknown; error: DatabaseError | null };
type MaybeSingleQuery = {
  select(columns: string): MaybeSingleQuery;
  eq(column: string, value: unknown): MaybeSingleQuery;
  order(column: string, options?: { ascending?: boolean }): MaybeSingleQuery;
  limit(count: number): MaybeSingleQuery;
  maybeSingle(): PromiseLike<DatabaseResult>;
};
type OutcomeGraphAdminClient = { from(table: string): MaybeSingleQuery };

const outcomeGraphAdmin = supabaseAdmin as unknown as OutcomeGraphAdminClient;

export async function getOutcomeGraphForecastForSale(
  saleId: string,
): Promise<OutcomeGraphForecast> {
  const lot = await selectMaybeOne(
    outcomeGraphAdmin
      .from("auction_lots")
      .select("id, active, initial_starting_price_eur")
      .eq("auction_sale_id", saleId)
      .maybeSingle(),
    lotSchema,
    "lecture du lot Outcome Graph",
  );

  if (!lot) {
    return buildOutcomeGraphRefusal(
      { saleId, startingPriceCents: null, marketValueCents: null },
      "Cette vente n’est pas encore reliée au registre Outcome Graph.",
      ["Aucune probabilité non vérifiée n’est publiée."],
    );
  }

  const round = await selectMaybeOne(
    outcomeGraphAdmin
      .from("auction_rounds")
      .select(
        "id, lot_id, sequence_number, scheduled_at, current_status, initial_starting_price_eur, effective_starting_price_eur",
      )
      .eq("lot_id", lot.id)
      .order("sequence_number", { ascending: false })
      .limit(1)
      .maybeSingle(),
    roundSchema,
    "lecture de l’audience Outcome Graph",
  );

  if (!round) {
    return buildOutcomeGraphRefusal(
      saleContext(saleId, lot, null),
      "Aucune audience versionnée n’est disponible pour cette vente.",
      ["Le catalogue de ventes ne remplace pas le registre des audiences."],
    );
  }

  const prediction = await selectMaybeOne(
    outcomeGraphAdmin
      .from("auction_predictions")
      .select(
        "id, round_id, snapshot_id, model_version_id, cohort_statistics_id, prediction_status, generated_at, created_at, horizon, probabilities, quantiles, confidence_level, confidence_label, sample_size, explanation_factors, limitations, refusal_reason",
      )
      .eq("round_id", round.id)
      .eq("prediction_kind", "outcome_graph")
      .order("generated_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    predictionSchema,
    "lecture de la prédiction Outcome Graph",
  );

  if (!prediction) {
    return buildOutcomeGraphRefusal(
      saleContext(saleId, lot, round),
      "Aucune prévision vérifiée n’est disponible pour cette audience.",
      ["Outcome Graph ne calcule pas de probabilité à partir de la seule annonce."],
    );
  }

  const [snapshot, model, cohortStatistics] = await Promise.all([
    selectMaybeOne(
      outcomeGraphAdmin
        .from("auction_feature_snapshots")
        .select(
          "id, lot_id, round_id, prediction_horizon, feature_cutoff_at, built_at, feature_schema_version, leakage_check_status, retrospective, features",
        )
        .eq("id", prediction.snapshot_id)
        .maybeSingle(),
      snapshotSchema,
      "lecture du snapshot Outcome Graph",
    ),
    selectMaybeOne(
      outcomeGraphAdmin
        .from("model_versions")
        .select(
          "id, model_key, version, status, feature_schema_version, training_cutoff_at, approved_at, created_at",
        )
        .eq("id", prediction.model_version_id)
        .maybeSingle(),
      modelSchema,
      "lecture du modèle Outcome Graph",
    ),
    prediction.cohort_statistics_id
      ? selectMaybeOne(
          outcomeGraphAdmin
            .from("cohort_statistics")
            .select(
              "id, cohort_definition_id, prediction_horizon, period_start, period_end, sample_size, tribunal_sample_size, training_eligible, has_blocking_conflict, created_at",
            )
            .eq("id", prediction.cohort_statistics_id)
            .maybeSingle(),
          cohortStatisticsSchema,
          "lecture des statistiques Outcome Graph",
        )
      : Promise.resolve(null),
  ]);

  const cohortDefinition = cohortStatistics
    ? await selectMaybeOne(
        outcomeGraphAdmin
          .from("cohort_definitions")
          .select("id, cohort_level, label")
          .eq("id", cohortStatistics.cohort_definition_id)
          .maybeSingle(),
        cohortDefinitionSchema,
        "lecture de la cohorte Outcome Graph",
      )
    : null;

  return decodeStoredOutcomeGraphForecast(saleId, {
    lot,
    round,
    prediction,
    snapshot,
    model,
    cohortStatistics,
    cohortDefinition,
  });
}

export function decodeStoredOutcomeGraphForecast(
  saleId: string,
  record: StoredOutcomeGraphRecord,
): OutcomeGraphForecast {
  const { lot, round, prediction, snapshot, model, cohortStatistics, cohortDefinition } = record;
  const safeContext = saleContext(saleId, lot, round, prediction, null, model);

  if (!prediction) {
    return buildOutcomeGraphRefusal(safeContext, "Aucune prévision vérifiée n’est disponible.");
  }
  if (prediction.prediction_status === "insufficient_data") {
    return buildOutcomeGraphRefusal(
      safeContext,
      prediction.refusal_reason ?? "Échantillon vérifié insuffisant.",
      stringArray(prediction.limitations),
    );
  }
  if (!snapshot || !model || !cohortStatistics || !cohortDefinition) {
    return buildOutcomeGraphRefusal(safeContext, "Traçabilité de la prévision incomplète.", [
      "Le snapshot, le modèle et la cohorte doivent tous être identifiables.",
    ]);
  }

  const chronologyError = validateStoredChronology(record);
  if (chronologyError) return buildOutcomeGraphRefusal(safeContext, chronologyError);
  const context = saleContext(saleId, lot, round, prediction, snapshot, model);
  if (!cohortStatistics.training_eligible || cohortStatistics.has_blocking_conflict) {
    return buildOutcomeGraphRefusal(
      context,
      cohortStatistics.has_blocking_conflict
        ? "Conflit de données bloquant à résoudre."
        : "Cohorte non éligible à la prévision.",
    );
  }

  if (prediction.sample_size !== cohortStatistics.sample_size) {
    return buildOutcomeGraphRefusal(
      context,
      "Taille d’échantillon incohérente avec la cohorte versionnée.",
    );
  }
  const sampleSize = prediction.sample_size;
  if (sampleSize < 10) {
    return buildOutcomeGraphRefusal(
      context,
      "Échantillon vérifié insuffisant : au moins 10 résultats A/B sont requis.",
    );
  }

  const probabilities = objectValue(prediction.probabilities);
  const heldProbability = probability(probabilities?.held_probability);
  const postponedProbability = probability(probabilities?.postponed_probability);
  const cancelledOrNotRequestedProbability = probability(
    probabilities?.cancelled_or_not_requested_probability,
  );
  const adjudicatedIfHeldProbability = probability(probabilities?.adjudicated_if_held_probability);
  const noBidIfHeldProbability = probability(probabilities?.no_bid_if_held_probability);
  const surenchereProbability = probability(probabilities?.surenchere_probability);
  const flowValues = [
    heldProbability,
    postponedProbability,
    cancelledOrNotRequestedProbability,
    adjudicatedIfHeldProbability,
    noBidIfHeldProbability,
    surenchereProbability,
  ];
  if (flowValues.some((value) => value == null)) {
    return buildOutcomeGraphRefusal(context, "Probabilités de prévision absentes ou invalides.");
  }
  if (
    !approximatelyOne(
      heldProbability! + postponedProbability! + cancelledOrNotRequestedProbability!,
    ) ||
    !approximatelyOne(adjudicatedIfHeldProbability! + noBidIfHeldProbability!)
  ) {
    return buildOutcomeGraphRefusal(context, "Probabilités conditionnelles incohérentes.");
  }

  const quantiles = objectValue(prediction.quantiles);
  const initialPrice = moneyQuantiles(objectValue(quantiles?.initial_price_eur));
  const finalPrice = moneyQuantiles(objectValue(quantiles?.final_price_eur));
  if (!initialPrice || !finalPrice) {
    return buildOutcomeGraphRefusal(context, "Quantiles de prix absents ou non monotones.");
  }

  const confidenceLabel = confidenceForSample(sampleSize);
  const confidenceScore =
    probability(prediction.confidence_level) ??
    (confidenceLabel === "élevé" ? 0.82 : confidenceLabel === "moyen" ? 0.65 : 0.45);
  const explanationFactors = factorArray(prediction.explanation_factors);
  const limitations = uniqueStrings([
    ...stringArray(prediction.limitations),
    "Prévision statistique, pas une garantie de déroulement ni de prix.",
    "Le plafond privé reste dans le navigateur et n’alimente aucune cohorte.",
  ]);

  const forecast: OutcomeGraphForecast = {
    saleId,
    roundId: round.id,
    predictionId: prediction.id,
    snapshotId: snapshot.id,
    status: "ready",
    generatedAt: prediction.generated_at,
    horizon: prediction.horizon,
    modelVersion: `${model.model_key}@${model.version}`,
    cohort: {
      id: cohortDefinition.id,
      label: cohortDefinition.label,
      level: cohortDefinition.cohort_level,
      periodStart: dateStart(cohortStatistics.period_start),
      periodEnd: dateEnd(cohortStatistics.period_end),
    },
    marketValueCents: context.marketValueCents,
    startingPriceCents: context.startingPriceCents,
    effectiveStartingPriceCents: context.effectiveStartingPriceCents ?? null,
    flow: {
      heldProbability,
      postponedProbability,
      cancelledOrNotRequestedProbability,
      adjudicatedIfHeldProbability,
      noBidIfHeldProbability,
    },
    initialPrice,
    surenchereProbability,
    finalPrice,
    ceiling: null,
    pressure: pressureValue(
      probabilities?.competitive_pressure ?? objectValue(snapshot.features)?.competitive_pressure,
    ),
    confidence: {
      label: confidenceLabel,
      score: confidenceScore,
      sampleSize,
      tribunalSampleSize: cohortStatistics.tribunal_sample_size,
    },
    delays: delayValues(probabilities?.delays),
    explanationFactors,
    limitations,
    refusalReason: null,
  };

  return forecast;
}

async function selectMaybeOne<T>(
  query: PromiseLike<DatabaseResult>,
  schema: z.ZodType<T>,
  operation: string,
): Promise<T | null> {
  const { data, error } = await query;
  if (error) throw new Error(`${operation} impossible: ${error.message}`);
  if (data == null) return null;
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`${operation} impossible: réponse du registre invalide.`);
  }
  return parsed.data;
}

function saleContext(
  saleId: string,
  lot: z.infer<typeof lotSchema>,
  round: z.infer<typeof roundSchema> | null,
  prediction?: z.infer<typeof predictionSchema> | null,
  snapshot?: z.infer<typeof snapshotSchema> | null,
  model?: z.infer<typeof modelSchema> | null,
) {
  const features = objectValue(snapshot?.features);
  const marketEstimate = objectValue(features?.market_estimate);
  const marketValueCents =
    euroValueToCents(features?.market_value_eur) ??
    euroValueToCents(marketEstimate?.p50_eur) ??
    safeCents(features?.market_value_cents);
  return {
    saleId,
    roundId: round?.id ?? null,
    predictionId: prediction?.id ?? null,
    snapshotId: snapshot?.id ?? null,
    startingPriceCents:
      euroValueToCents(round?.initial_starting_price_eur) ??
      euroValueToCents(lot.initial_starting_price_eur),
    effectiveStartingPriceCents:
      euroValueToCents(round?.effective_starting_price_eur) ??
      euroValueToCents(round?.initial_starting_price_eur) ??
      euroValueToCents(lot.initial_starting_price_eur),
    marketValueCents,
    generatedAt: prediction?.generated_at,
    horizon: prediction?.horizon,
    modelVersion: model ? `${model.model_key}@${model.version}` : undefined,
  };
}

function validateStoredChronology(record: StoredOutcomeGraphRecord): string | null {
  const { lot, round, prediction, snapshot, model, cohortStatistics } = record;
  if (!prediction || !snapshot || !model || !cohortStatistics) {
    return "Traçabilité de la prévision incomplète.";
  }
  if (
    prediction.round_id !== round.id ||
    snapshot.round_id !== round.id ||
    snapshot.lot_id !== round.lot_id ||
    prediction.snapshot_id !== snapshot.id ||
    prediction.model_version_id !== model.id
  ) {
    return "Relations de traçabilité incohérentes.";
  }
  if (
    prediction.horizon !== snapshot.prediction_horizon ||
    prediction.horizon !== cohortStatistics.prediction_horizon
  ) {
    return "Horizons du snapshot, de la cohorte et de la prévision incohérents.";
  }
  if (snapshot.retrospective || snapshot.leakage_check_status !== "passed") {
    return "Snapshot pré-audience non admissible ou contrôle anti-fuite non validé.";
  }
  if (!lot.active || !FORECASTABLE_ROUND_STATUSES.has(round.current_status)) {
    return "Audience non active ou déjà sortie de sa phase prévisionnelle.";
  }
  if (
    !validDate(snapshot.feature_cutoff_at) ||
    !validDate(snapshot.built_at) ||
    !validDate(prediction.generated_at) ||
    !validDate(prediction.created_at) ||
    !validDate(model.created_at) ||
    !validDate(model.approved_at) ||
    !validDate(cohortStatistics.created_at)
  ) {
    return "Horodatage de prévision invalide.";
  }
  const featureCutoffAt = Date.parse(snapshot.feature_cutoff_at);
  const builtAt = Date.parse(snapshot.built_at);
  const generatedAt = Date.parse(prediction.generated_at);
  if (
    featureCutoffAt > builtAt ||
    generatedAt < builtAt ||
    Date.parse(prediction.created_at) < generatedAt
  ) {
    return "Chronologie du snapshot et de la prévision incohérente.";
  }
  if (
    model.feature_schema_version !== snapshot.feature_schema_version ||
    Date.parse(model.created_at) > generatedAt ||
    Date.parse(model.approved_at!) > generatedAt
  ) {
    return "Modèle non compatible ou approuvé après la prévision.";
  }
  if (
    model.training_cutoff_at != null &&
    (!validDate(model.training_cutoff_at) || Date.parse(model.training_cutoff_at) > featureCutoffAt)
  ) {
    return "Cutoff d’entraînement du modèle postérieur au snapshot.";
  }
  if (
    Date.parse(cohortStatistics.created_at) > featureCutoffAt ||
    Date.parse(dateEnd(cohortStatistics.period_end)) > featureCutoffAt
  ) {
    return "Cohorte calculée avec des données postérieures au cutoff.";
  }
  if (!round.scheduled_at) {
    return "Date d’audience requise pour publier une prévision.";
  }
  if (!validDate(round.scheduled_at)) return "Date d’audience invalide.";
  const scheduledAt = Date.parse(round.scheduled_at);
  if (
    Date.parse(snapshot.feature_cutoff_at) >= scheduledAt ||
    Date.parse(prediction.generated_at) >= scheduledAt
  ) {
    return "Prévision postérieure à l’audience refusée par le contrôle anti-fuite.";
  }
  if (model.status !== "active") {
    return "Version de modèle non active.";
  }
  return null;
}

function moneyQuantiles(value: Record<string, unknown> | null): OutcomeGraphQuantiles | null {
  const p10Cents = euroValueToCents(value?.p10);
  const p50Cents = euroValueToCents(value?.p50);
  const p90Cents = euroValueToCents(value?.p90);
  if (
    p10Cents == null ||
    p50Cents == null ||
    p90Cents == null ||
    p10Cents <= 0 ||
    p10Cents > p50Cents ||
    p50Cents > p90Cents
  ) {
    return null;
  }
  return { p10Cents, p50Cents, p90Cents };
}

function euroValueToCents(value: unknown): number | null {
  const normalized =
    typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : String(value ?? "");
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(normalized.trim());
  if (!match) return null;
  const euros = BigInt(match[1]);
  const decimals = BigInt((match[2] ?? "").padEnd(2, "0"));
  const cents = euros * 100n + decimals;
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

function safeCents(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function probability(value: unknown): OutcomeGraphProbability {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : null;
}

function confidenceForSample(sampleSize: number): OutcomeGraphConfidenceLabel {
  return sampleSize >= 100 ? "élevé" : sampleSize >= 30 ? "moyen" : "faible";
}

function delayValues(value: unknown): OutcomeGraphForecast["delays"] {
  const delays = objectValue(value);
  if (!delays) return null;
  const result = {
    heldWithin30DaysProbability: probability(delays.held_within_30_days_probability),
    heldWithin60DaysProbability: probability(delays.held_within_60_days_probability),
    resultKnownWithin48HoursProbability: probability(
      delays.result_known_within_48_hours_probability,
    ),
    finalityKnownWithin15DaysProbability: probability(
      delays.finality_known_within_15_days_probability,
    ),
    newRoundWithin4MonthsAfterSurenchereProbability: probability(
      delays.new_round_within_4_months_after_surenchere_probability,
    ),
  };
  return Object.values(result).every((entry) => entry == null) ? null : result;
}

function pressureValue(value: unknown): OutcomeGraphForecast["pressure"] {
  const pressure = objectValue(value);
  const rawScore = finiteNumber(pressure?.score);
  if (rawScore == null || rawScore < 0 || rawScore > 100) return null;
  const score = Math.round(rawScore);
  const rawCoverage = probability(pressure?.coverage);
  const components = Array.isArray(pressure?.components)
    ? pressure.components.map(pressureComponent).filter(isPressureComponent)
    : [];
  return {
    score,
    label: score >= 70 ? "élevée" : score >= 40 ? "modérée" : "faible",
    coverage: rawCoverage ?? 0,
    components,
  };
}

function pressureComponent(value: unknown): OutcomeGraphPressureComponent | null {
  const component = objectValue(value);
  const key = component?.key;
  const label = component?.label;
  const componentScore = finiteNumber(component?.score);
  const weight = finiteNumber(component?.weight);
  if (
    !["discount", "adjudication", "qualified_demand", "history", "liquidity"].includes(
      String(key),
    ) ||
    typeof label !== "string" ||
    weight == null ||
    weight < 0 ||
    weight > 1 ||
    (componentScore != null && (componentScore < 0 || componentScore > 100))
  ) {
    return null;
  }
  return {
    key: key as OutcomeGraphPressureComponent["key"],
    label,
    score: componentScore,
    weight,
  };
}

function isPressureComponent(
  value: OutcomeGraphPressureComponent | null,
): value is OutcomeGraphPressureComponent {
  return value != null;
}

function factorArray(value: unknown): OutcomeGraphForecast["explanationFactors"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const factor = objectValue(entry);
    if (typeof factor?.label !== "string" || typeof factor.detail !== "string") return [];
    const direction = ["up", "down", "neutral"].includes(String(factor.direction))
      ? (factor.direction as "up" | "down" | "neutral")
      : "neutral";
    return [{ label: factor.label, detail: factor.detail, direction }];
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : [];
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

function approximatelyOne(value: number): boolean {
  return Math.abs(value - 1) <= 0.02;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function dateStart(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
}

function dateEnd(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
