import { describe, expect, it } from "vitest";
import {
  decodeStoredOutcomeGraphForecast,
  type StoredOutcomeGraphRecord,
} from "@/lib/outcome-graph-repository";

const saleId = "11111111-1111-4111-8111-111111111111";

function storedRecord(overrides: Partial<StoredOutcomeGraphRecord> = {}): StoredOutcomeGraphRecord {
  return {
    lot: {
      id: "22222222-2222-4222-8222-222222222222",
      active: true,
      initial_starting_price_eur: "90000.00",
    },
    round: {
      id: "33333333-3333-4333-8333-333333333333",
      lot_id: "22222222-2222-4222-8222-222222222222",
      sequence_number: 1,
      scheduled_at: "2026-08-01T09:00:00.000Z",
      current_status: "confirmed",
      initial_starting_price_eur: "90000.00",
      effective_starting_price_eur: "90000.00",
    },
    prediction: {
      id: "44444444-4444-4444-8444-444444444444",
      round_id: "33333333-3333-4333-8333-333333333333",
      snapshot_id: "55555555-5555-4555-8555-555555555555",
      model_version_id: "66666666-6666-4666-8666-666666666666",
      cohort_statistics_id: "77777777-7777-4777-8777-777777777777",
      prediction_status: "ready",
      generated_at: "2026-07-25T12:00:00.000Z",
      created_at: "2026-07-25T12:01:00.000Z",
      horizon: "T-7",
      probabilities: {
        held_probability: 0.88,
        postponed_probability: 0.08,
        cancelled_or_not_requested_probability: 0.04,
        adjudicated_if_held_probability: 0.91,
        no_bid_if_held_probability: 0.09,
        surenchere_probability: 0.1,
        competitive_pressure: { score: 76, coverage: 0.7, components: [] },
      },
      quantiles: {
        initial_price_eur: { p10: "123000.10", p50: "146000.20", p90: "179000.30" },
        final_price_eur: { p10: "126000.15", p50: "151000.25", p90: "188000.35" },
      },
      confidence_level: "0.66",
      confidence_label: "moyen",
      sample_size: 47,
      explanation_factors: [{ label: "Cohorte", detail: "47 résultats A/B", direction: "neutral" }],
      limitations: ["Résultat statistique."],
      refusal_reason: null,
    },
    snapshot: {
      id: "55555555-5555-4555-8555-555555555555",
      lot_id: "22222222-2222-4222-8222-222222222222",
      round_id: "33333333-3333-4333-8333-333333333333",
      prediction_horizon: "T-7",
      feature_cutoff_at: "2026-07-24T09:00:00.000Z",
      built_at: "2026-07-24T10:00:00.000Z",
      feature_schema_version: "outcome-v1",
      leakage_check_status: "passed",
      retrospective: false,
      features: { market_value_eur: "172000.40" },
    },
    model: {
      id: "66666666-6666-4666-8666-666666666666",
      model_key: "outcome_cohort",
      version: "1.0.0",
      status: "active",
      feature_schema_version: "outcome-v1",
      training_cutoff_at: "2026-06-30T23:59:59.000Z",
      approved_at: "2026-07-20T09:00:00.000Z",
      created_at: "2026-07-19T09:00:00.000Z",
    },
    cohortStatistics: {
      id: "77777777-7777-4777-8777-777777777777",
      cohort_definition_id: "88888888-8888-4888-8888-888888888888",
      prediction_horizon: "T-7",
      period_start: "2024-01-01",
      period_end: "2026-06-30",
      sample_size: 47,
      tribunal_sample_size: 19,
      training_eligible: true,
      has_blocking_conflict: false,
      created_at: "2026-07-23T09:00:00.000Z",
    },
    cohortDefinition: {
      id: "88888888-8888-4888-8888-888888888888",
      cohort_level: "national_property_type",
      label: "National · appartement",
    },
    ...overrides,
  };
}

describe("decodeStoredOutcomeGraphForecast", () => {
  it("publie une projection traçable en centimes entiers et sépare les états", () => {
    const forecast = decodeStoredOutcomeGraphForecast(saleId, storedRecord());

    expect(forecast.status).toBe("ready");
    expect(forecast.startingPriceCents).toBe(9_000_000);
    expect(forecast.marketValueCents).toBe(17_200_040);
    expect(forecast.finalPrice).toEqual({
      p10Cents: 12_600_015,
      p50Cents: 15_100_025,
      p90Cents: 18_800_035,
    });
    expect(forecast.flow.postponedProbability).toBe(0.08);
    expect(forecast.flow.cancelledOrNotRequestedProbability).toBe(0.04);
    expect(forecast.confidence).toMatchObject({ label: "moyen", sampleSize: 47 });
    expect(forecast.ceiling).toBeNull();
    expect(JSON.stringify(forecast)).not.toMatch(/probabilit. de gagner/i);
  });

  it("refuse un snapshot rétrospectif même si une prédiction existe", () => {
    const base = storedRecord();
    const forecast = decodeStoredOutcomeGraphForecast(
      saleId,
      storedRecord({ snapshot: { ...base.snapshot!, retrospective: true } }),
    );

    expect(forecast.status).toBe("insufficient_data");
    expect(forecast.refusalReason).toContain("anti-fuite");
    expect(forecast.flow.heldProbability).toBeNull();
    expect(forecast.marketValueCents).toBeNull();
  });

  it("cesse de publier dès que l’audience sort de la phase prévisionnelle", () => {
    const base = storedRecord();
    const forecast = decodeStoredOutcomeGraphForecast(
      saleId,
      storedRecord({ round: { ...base.round, current_status: "cancelled" } }),
    );

    expect(forecast.status).toBe("insufficient_data");
    expect(forecast.refusalReason).toContain("phase prévisionnelle");
    expect(forecast.finalPrice).toBeNull();
  });

  it("cesse de publier lorsque le lot est désactivé", () => {
    const base = storedRecord();
    const forecast = decodeStoredOutcomeGraphForecast(
      saleId,
      storedRecord({ lot: { ...base.lot, active: false } }),
    );

    expect(forecast.status).toBe("insufficient_data");
    expect(forecast.refusalReason).toContain("Audience non active");
  });

  it("refuse une prévision ou un cutoff postérieurs à l’audience", () => {
    const base = storedRecord();
    const forecast = decodeStoredOutcomeGraphForecast(
      saleId,
      storedRecord({
        prediction: {
          ...base.prediction!,
          generated_at: "2026-08-01T10:00:00.000Z",
          created_at: "2026-08-01T10:01:00.000Z",
        },
      }),
    );

    expect(forecast.status).toBe("insufficient_data");
    expect(forecast.refusalReason).toContain("postérieure");
  });

  it("refuse une prédiction antérieure à la construction de son snapshot", () => {
    const base = storedRecord();
    const forecast = decodeStoredOutcomeGraphForecast(
      saleId,
      storedRecord({
        snapshot: { ...base.snapshot!, built_at: "2026-07-25T13:00:00.000Z" },
      }),
    );

    expect(forecast.status).toBe("insufficient_data");
    expect(forecast.refusalReason).toContain("Chronologie");
  });

  it("refuse une cohorte calculée après le cutoff du snapshot", () => {
    const base = storedRecord();
    const forecast = decodeStoredOutcomeGraphForecast(
      saleId,
      storedRecord({
        cohortStatistics: {
          ...base.cohortStatistics!,
          created_at: "2026-07-24T10:00:00.000Z",
        },
      }),
    );

    expect(forecast.status).toBe("insufficient_data");
    expect(forecast.refusalReason).toContain("postérieures au cutoff");
  });

  it("refuse une prévision ready sans date d’audience vérifiable", () => {
    const base = storedRecord();
    const forecast = decodeStoredOutcomeGraphForecast(
      saleId,
      storedRecord({ round: { ...base.round, scheduled_at: null } }),
    );

    expect(forecast.status).toBe("insufficient_data");
    expect(forecast.refusalReason).toContain("Date d’audience requise");
  });

  it("refuse un modèle validé mais pas activé pour la restitution client", () => {
    const base = storedRecord();
    const forecast = decodeStoredOutcomeGraphForecast(
      saleId,
      storedRecord({ model: { ...base.model!, status: "validated" } }),
    );

    expect(forecast.status).toBe("insufficient_data");
    expect(forecast.refusalReason).toContain("non active");
  });

  it("refuse une taille d’échantillon différente de la cohorte versionnée", () => {
    const base = storedRecord();
    const forecast = decodeStoredOutcomeGraphForecast(
      saleId,
      storedRecord({ prediction: { ...base.prediction!, sample_size: 48 } }),
    );

    expect(forecast.status).toBe("insufficient_data");
    expect(forecast.refusalReason).toContain("échantillon incohérente");
  });

  it("refuse des quantiles non monotones sans fabriquer de distribution", () => {
    const base = storedRecord();
    const forecast = decodeStoredOutcomeGraphForecast(
      saleId,
      storedRecord({
        prediction: {
          ...base.prediction!,
          quantiles: {
            initial_price_eur: { p10: "120000", p50: "140000", p90: "180000" },
            final_price_eur: { p10: "190000", p50: "150000", p90: "180000" },
          },
        },
      }),
    );

    expect(forecast.status).toBe("insufficient_data");
    expect(forecast.finalPrice).toBeNull();
    expect(forecast.refusalReason).toContain("non monotones");
  });

  it("conserve le motif explicite d’une prédiction insuffisante", () => {
    const base = storedRecord();
    const forecast = decodeStoredOutcomeGraphForecast(
      saleId,
      storedRecord({
        prediction: {
          ...base.prediction!,
          prediction_status: "insufficient_data",
          refusal_reason: "Seulement 7 résultats A/B vérifiés.",
          sample_size: 7,
        },
      }),
    );

    expect(forecast.status).toBe("insufficient_data");
    expect(forecast.refusalReason).toBe("Seulement 7 résultats A/B vérifiés.");
    expect(forecast.ceiling).toBeNull();
  });
});
