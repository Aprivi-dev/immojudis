import { describe, expect, it } from "vitest";
import {
  buildBaselineOutcomeGraph,
  cumulativeProbability,
  withOutcomeGraphCeiling,
  type OutcomeGraphCohort,
  type OutcomeGraphSaleContext,
} from "@/lib/outcome-graph";

const context: OutcomeGraphSaleContext = {
  saleId: "00000000-0000-4000-8000-000000000001",
  roundId: "00000000-0000-4000-8000-000000000002",
  startingPriceCents: 9_000_000,
  effectiveStartingPriceCents: 9_000_000,
  marketValueCents: 17_200_000,
  ceilingCents: 15_000_000,
  generatedAt: "2026-07-29T12:00:00.000Z",
  horizon: "T-7",
  modelVersion: "cohort_baseline_v1",
};

function cohort(overrides: Partial<OutcomeGraphCohort> = {}): OutcomeGraphCohort {
  return {
    id: "00000000-0000-4000-8000-000000000003",
    label: "National · appartement · saisie immobilière",
    level: "national_property_type",
    sampleSize: 47,
    tribunalSampleSize: 19,
    periodStart: "2024-01-01T00:00:00.000Z",
    periodEnd: "2026-06-30T23:59:59.000Z",
    trainingEligible: true,
    hasBlockingConflict: false,
    flow: {
      heldProbability: 0.88,
      postponedProbability: 0.08,
      cancelledOrNotRequestedProbability: 0.04,
      adjudicatedIfHeldProbability: 0.91,
      noBidIfHeldProbability: 0.09,
    },
    initialPriceRatios: { p10: 1.3667, p50: 1.6222, p90: 1.9889 },
    finalPriceRatios: { p10: 1.4, p50: 1.6778, p90: 2.0889 },
    surenchereProbability: 0.1,
    pressure: {
      qualifiedDemandScore: 72,
      historyScore: 64,
      liquidityScore: 81,
      attractivenessScore: 69,
    },
    delays: {
      heldWithin30DaysProbability: 0.71,
      heldWithin60DaysProbability: 0.9,
      resultKnownWithin48HoursProbability: 0.78,
      finalityKnownWithin15DaysProbability: 0.83,
      newRoundWithin4MonthsAfterSurenchereProbability: 0.66,
    },
    ...overrides,
  };
}

describe("buildBaselineOutcomeGraph", () => {
  it("produit une prévision baseline explicable sans inventer de cohorte", () => {
    const forecast = buildBaselineOutcomeGraph(context, cohort());

    expect(forecast.status).toBe("ready");
    expect(forecast.initialPrice).toEqual({
      p10Cents: 12_300_300,
      p50Cents: 14_599_800,
      p90Cents: 17_900_100,
    });
    expect(forecast.finalPrice).toEqual({
      p10Cents: 12_600_000,
      p50Cents: 15_100_200,
      p90Cents: 18_800_100,
    });
    expect(forecast.confidence).toMatchObject({
      label: "moyen",
      sampleSize: 47,
      tribunalSampleSize: 19,
    });
    expect(forecast.cohort?.label).toBe("National · appartement · saisie immobilière");
    expect(forecast.limitations.join(" ")).not.toMatch(/gagner/i);
  });

  it.each([
    [9, "insufficient_data", null],
    [10, "ready", "faible"],
    [29, "ready", "faible"],
    [30, "ready", "moyen"],
    [99, "ready", "moyen"],
    [100, "ready", "élevé"],
  ] as const)("applique le seuil de cohorte n=%s", (sampleSize, status, confidence) => {
    const forecast = buildBaselineOutcomeGraph(context, cohort({ sampleSize }));
    expect(forecast.status).toBe(status);
    expect(forecast.confidence?.label ?? null).toBe(confidence);
  });

  it("refuse une probabilité inconnue au lieu de la transformer en zéro", () => {
    const forecast = buildBaselineOutcomeGraph(
      context,
      cohort({
        flow: {
          heldProbability: null,
          postponedProbability: 0.08,
          cancelledOrNotRequestedProbability: 0.04,
          adjudicatedIfHeldProbability: 0.91,
          noBidIfHeldProbability: 0.09,
        },
      }),
    );

    expect(forecast.status).toBe("insufficient_data");
    expect(forecast.flow.heldProbability).toBeNull();
    expect(forecast.refusalReason).toContain("absentes");
  });

  it("n’invente aucune provenance lorsqu’un refus n’en possède pas", () => {
    const forecast = buildBaselineOutcomeGraph(
      {
        saleId: context.saleId,
        startingPriceCents: context.startingPriceCents,
        marketValueCents: context.marketValueCents,
      },
      cohort({ sampleSize: 4 }),
    );

    expect(forecast.status).toBe("insufficient_data");
    expect(forecast.generatedAt).toBeNull();
    expect(forecast.horizon).toBeNull();
    expect(forecast.modelVersion).toBeNull();
  });

  it("refuse les probabilités hors limites et les paires conditionnelles incohérentes", () => {
    expect(
      buildBaselineOutcomeGraph(context, cohort({ surenchereProbability: 1.2 })).refusalReason,
    ).toContain("invalides");
    expect(
      buildBaselineOutcomeGraph(
        context,
        cohort({
          flow: {
            heldProbability: 0.88,
            postponedProbability: 0.25,
            cancelledOrNotRequestedProbability: 0.15,
            adjudicatedIfHeldProbability: 0.91,
            noBidIfHeldProbability: 0.09,
          },
        }),
      ).refusalReason,
    ).toContain("incohérentes");
  });

  it("refuse les quantiles non monotones", () => {
    const forecast = buildBaselineOutcomeGraph(
      context,
      cohort({ finalPriceRatios: { p10: 1.4, p50: 2.2, p90: 1.9 } }),
    );
    expect(forecast.status).toBe("insufficient_data");
    expect(forecast.refusalReason).toContain("non monotones");
  });

  it("sépare la probabilité conditionnelle sous plafond de la probabilité combinée", () => {
    const forecast = buildBaselineOutcomeGraph(context, cohort());
    expect(forecast.ceiling).not.toBeNull();
    expect(forecast.ceiling!.finalPriceBelowOrEqualIfAdjudicatedProbability).toBeGreaterThan(0);
    expect(forecast.ceiling!.adjudicationAndFinalPriceBelowOrEqualProbability).toBeCloseTo(
      forecast.ceiling!.finalPriceBelowOrEqualIfAdjudicatedProbability * 0.88 * 0.91,
      3,
    );
    expect(forecast.ceiling!.adjudicationAndFinalPriceBelowOrEqualProbability).toBeLessThan(
      forecast.ceiling!.finalPriceBelowOrEqualIfAdjudicatedProbability,
    );
  });

  it("recalcule localement un plafond privé sans altérer la provenance", () => {
    const forecast = buildBaselineOutcomeGraph(context, cohort());
    const lower = withOutcomeGraphCeiling(forecast, 12_000_000);
    const higher = withOutcomeGraphCeiling(forecast, 18_000_000);

    expect(lower.ceiling!.amountCents).toBe(12_000_000);
    expect(higher.ceiling!.finalPriceBelowOrEqualIfAdjudicatedProbability).toBeGreaterThan(
      lower.ceiling!.finalPriceBelowOrEqualIfAdjudicatedProbability,
    );
    expect(higher.predictionId).toBe(forecast.predictionId);
    expect(higher.snapshotId).toBe(forecast.snapshotId);
  });

  it("produit une courbe cumulative monotone aux ancrages P10/P50/P90", () => {
    const distribution = {
      p10Cents: 12_600_000,
      p50Cents: 15_100_000,
      p90Cents: 18_800_000,
    };
    expect(cumulativeProbability(distribution, 12_600_000)).toBeCloseTo(0.1, 6);
    expect(cumulativeProbability(distribution, 15_100_000)).toBeCloseTo(0.5, 6);
    expect(cumulativeProbability(distribution, 18_800_000)).toBeCloseTo(0.9, 6);
    const curve = [8_000_000, 12_000_000, 14_000_000, 15_000_000, 18_000_000, 22_000_000].map(
      (price) => cumulativeProbability(distribution, price),
    );
    expect(curve).toEqual([...curve].sort((left, right) => left - right));
  });

  it("refuse une cohorte conflictuelle ou non éligible", () => {
    expect(
      buildBaselineOutcomeGraph(context, cohort({ hasBlockingConflict: true })).refusalReason,
    ).toContain("Conflit");
    expect(
      buildBaselineOutcomeGraph(context, cohort({ trainingEligible: false })).refusalReason,
    ).toContain("non éligible");
  });
});

describe.each([
  { name: "adjudication simple", context: {}, cohort: {} },
  { name: "report", context: {}, cohort: {} },
  { name: "enchères désertes", context: {}, cohort: {} },
  { name: "annulation", context: {}, cohort: {} },
  { name: "surenchère", context: {}, cohort: { surenchereProbability: 0.25 } },
  { name: "multi-lots", context: { saleId: "lot-2" }, cohort: {} },
  {
    name: "baisse de mise à prix",
    context: { effectiveStartingPriceCents: 7_200_000 },
    cohort: {},
  },
  {
    name: "conflit",
    context: {},
    cohort: { hasBlockingConflict: true },
    refused: true,
  },
  { name: "adresse occultée", context: { marketValueCents: null }, cohort: {} },
  { name: "réitération", context: { roundId: "reiteration-round" }, cohort: {} },
] satisfies Array<{
  name: string;
  context: Partial<OutcomeGraphSaleContext>;
  cohort: Partial<OutcomeGraphCohort>;
  refused?: boolean;
}>)("fixture $name", (fixture) => {
  it("préserve le scénario sans confondre absence et résultat négatif", () => {
    const forecast = buildBaselineOutcomeGraph(
      { ...context, ...fixture.context },
      cohort(fixture.cohort),
    );
    expect(forecast.status).toBe(fixture.refused ? "insufficient_data" : "ready");
    if (!fixture.refused) {
      expect(forecast.flow.noBidIfHeldProbability).toBe(0.09);
      expect(forecast.flow.postponedProbability).toBe(0.08);
      expect(forecast.flow.cancelledOrNotRequestedProbability).toBe(0.04);
    }
  });
});
