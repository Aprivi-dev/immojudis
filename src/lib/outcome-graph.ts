export type OutcomeGraphHorizon = "T-30" | "T-14" | "T-7" | "T-1" | "T-2h";

export type OutcomeGraphConfidenceLabel = "faible" | "moyen" | "élevé";

export type OutcomeGraphQuantiles = {
  p10Cents: number;
  p50Cents: number;
  p90Cents: number;
};

export type OutcomeGraphProbability = number | null;

export type OutcomeGraphCohort = {
  id: string;
  label: string;
  level:
    | "tribunal_procedure_type_occupation_discount"
    | "tribunal_procedure_type"
    | "region_procedure_type"
    | "national_procedure_type"
    | "national_property_type"
    | "national";
  sampleSize: number;
  tribunalSampleSize: number;
  periodStart: string;
  periodEnd: string;
  trainingEligible: boolean;
  hasBlockingConflict: boolean;
  flow: {
    heldProbability: OutcomeGraphProbability;
    postponedProbability: OutcomeGraphProbability;
    cancelledOrNotRequestedProbability: OutcomeGraphProbability;
    adjudicatedIfHeldProbability: OutcomeGraphProbability;
    noBidIfHeldProbability: OutcomeGraphProbability;
  };
  initialPriceRatios: {
    p10: number | null;
    p50: number | null;
    p90: number | null;
  };
  finalPriceRatios: {
    p10: number | null;
    p50: number | null;
    p90: number | null;
  };
  surenchereProbability: OutcomeGraphProbability;
  pressure?: {
    qualifiedDemandScore?: number | null;
    historyScore?: number | null;
    liquidityScore?: number | null;
    attractivenessScore?: number | null;
  };
  delays?: {
    heldWithin30DaysProbability?: OutcomeGraphProbability;
    heldWithin60DaysProbability?: OutcomeGraphProbability;
    resultKnownWithin48HoursProbability?: OutcomeGraphProbability;
    finalityKnownWithin15DaysProbability?: OutcomeGraphProbability;
    newRoundWithin4MonthsAfterSurenchereProbability?: OutcomeGraphProbability;
  };
};

export type OutcomeGraphSaleContext = {
  saleId: string;
  roundId?: string | null;
  predictionId?: string | null;
  snapshotId?: string | null;
  startingPriceCents: number | null;
  effectiveStartingPriceCents?: number | null;
  marketValueCents: number | null;
  ceilingCents?: number | null;
  generatedAt?: string;
  horizon?: OutcomeGraphHorizon;
  modelVersion?: string;
};

export type OutcomeGraphPressureComponent = {
  key: "discount" | "adjudication" | "qualified_demand" | "history" | "liquidity";
  label: string;
  score: number | null;
  weight: number;
};

export type OutcomeGraphForecast = {
  saleId: string;
  roundId: string | null;
  predictionId: string | null;
  snapshotId: string | null;
  status: "ready" | "insufficient_data";
  generatedAt: string | null;
  horizon: OutcomeGraphHorizon | null;
  modelVersion: string | null;
  cohort: {
    id: string;
    label: string;
    level: OutcomeGraphCohort["level"];
    periodStart: string;
    periodEnd: string;
  } | null;
  marketValueCents: number | null;
  startingPriceCents: number | null;
  effectiveStartingPriceCents: number | null;
  flow: {
    heldProbability: OutcomeGraphProbability;
    postponedProbability: OutcomeGraphProbability;
    cancelledOrNotRequestedProbability: OutcomeGraphProbability;
    adjudicatedIfHeldProbability: OutcomeGraphProbability;
    noBidIfHeldProbability: OutcomeGraphProbability;
  };
  initialPrice: OutcomeGraphQuantiles | null;
  surenchereProbability: OutcomeGraphProbability;
  finalPrice: OutcomeGraphQuantiles | null;
  ceiling: {
    amountCents: number;
    finalPriceBelowOrEqualIfAdjudicatedProbability: number;
    adjudicationAndFinalPriceBelowOrEqualProbability: number;
  } | null;
  pressure: {
    score: number;
    label: "faible" | "modérée" | "élevée";
    coverage: number;
    components: OutcomeGraphPressureComponent[];
  } | null;
  confidence: {
    label: OutcomeGraphConfidenceLabel;
    score: number;
    sampleSize: number;
    tribunalSampleSize: number;
  } | null;
  delays: {
    heldWithin30DaysProbability: OutcomeGraphProbability;
    heldWithin60DaysProbability: OutcomeGraphProbability;
    resultKnownWithin48HoursProbability: OutcomeGraphProbability;
    finalityKnownWithin15DaysProbability: OutcomeGraphProbability;
    newRoundWithin4MonthsAfterSurenchereProbability: OutcomeGraphProbability;
  } | null;
  explanationFactors: Array<{
    label: string;
    detail: string;
    direction: "up" | "down" | "neutral";
  }>;
  limitations: string[];
  refusalReason: string | null;
};

const MIN_AUTONOMOUS_SAMPLE = 10;
export function buildBaselineOutcomeGraph(
  context: OutcomeGraphSaleContext,
  cohort: OutcomeGraphCohort,
): OutcomeGraphForecast {
  const base = baseForecast(context);
  const refusalReason = validateInputs(context, cohort);
  if (refusalReason) {
    return {
      ...base,
      cohort: cohortMetadata(cohort),
      refusalReason,
      limitations: [refusalReason, ...baselineLimitations(cohort)],
    };
  }

  const effectiveStartingPriceCents = money(
    context.effectiveStartingPriceCents ?? context.startingPriceCents!,
  );
  const initialPrice = ratioQuantiles(effectiveStartingPriceCents, cohort.initialPriceRatios);
  const finalPrice = ratioQuantiles(effectiveStartingPriceCents, cohort.finalPriceRatios);
  const ceilingAmountCents = money(context.ceilingCents ?? finalPrice.p50Cents);
  const conditionalCeilingProbability = cumulativeProbability(finalPrice, ceilingAmountCents);
  const adjudicationProbability =
    cohort.flow.heldProbability! * cohort.flow.adjudicatedIfHeldProbability!;
  const pressure = competitivePressure(context, cohort);
  const confidence = confidenceForSample(cohort.sampleSize, cohort.tribunalSampleSize);

  return {
    ...base,
    status: "ready",
    cohort: cohortMetadata(cohort),
    effectiveStartingPriceCents,
    flow: {
      heldProbability: cohort.flow.heldProbability,
      postponedProbability: cohort.flow.postponedProbability,
      cancelledOrNotRequestedProbability: cohort.flow.cancelledOrNotRequestedProbability,
      adjudicatedIfHeldProbability: cohort.flow.adjudicatedIfHeldProbability,
      noBidIfHeldProbability: cohort.flow.noBidIfHeldProbability,
    },
    initialPrice,
    surenchereProbability: cohort.surenchereProbability,
    finalPrice,
    ceiling: {
      amountCents: ceilingAmountCents,
      finalPriceBelowOrEqualIfAdjudicatedProbability: roundProbability(
        conditionalCeilingProbability,
      ),
      adjudicationAndFinalPriceBelowOrEqualProbability: roundProbability(
        adjudicationProbability * conditionalCeilingProbability,
      ),
    },
    pressure,
    confidence,
    delays: normalizeDelays(cohort.delays),
    explanationFactors: explanationFactors(context, cohort, pressure),
    limitations: baselineLimitations(cohort),
    refusalReason: null,
  };
}

export function buildOutcomeGraphRefusal(
  context: OutcomeGraphSaleContext,
  refusalReason: string,
  limitations: string[] = [],
): OutcomeGraphForecast {
  return {
    ...baseForecast(context),
    refusalReason,
    limitations: [refusalReason, ...limitations],
  };
}

export function withOutcomeGraphCeiling(
  forecast: OutcomeGraphForecast,
  ceilingCents: number,
): OutcomeGraphForecast {
  if (forecast.status !== "ready" || !forecast.finalPrice) return forecast;
  const amountCents = money(ceilingCents);
  const conditionalProbability = cumulativeProbability(forecast.finalPrice, amountCents);
  const held = forecast.flow.heldProbability ?? 0;
  const adjudicatedIfHeld = forecast.flow.adjudicatedIfHeldProbability ?? 0;

  return {
    ...forecast,
    ceiling: {
      amountCents,
      finalPriceBelowOrEqualIfAdjudicatedProbability: roundProbability(conditionalProbability),
      adjudicationAndFinalPriceBelowOrEqualProbability: roundProbability(
        held * adjudicatedIfHeld * conditionalProbability,
      ),
    },
  };
}

export function cumulativeProbability(
  quantiles: OutcomeGraphQuantiles,
  ceilingCents: number,
): number {
  const price = Math.max(0, ceilingCents);
  const lowTail = Math.max(1, quantiles.p10Cents * 0.5);
  const highTail = Math.max(quantiles.p90Cents + 1, quantiles.p90Cents * 1.5);
  const anchors = [
    [0, 0],
    [lowTail, 0.01],
    [quantiles.p10Cents, 0.1],
    [quantiles.p50Cents, 0.5],
    [quantiles.p90Cents, 0.9],
    [highTail, 0.99],
  ] as const;

  if (price >= highTail) return 1;
  for (let index = 1; index < anchors.length; index += 1) {
    const [rightPrice, rightProbability] = anchors[index];
    if (price > rightPrice) continue;
    const [leftPrice, leftProbability] = anchors[index - 1];
    if (rightPrice === leftPrice) return rightProbability;
    const progress =
      leftPrice <= 0
        ? (price - leftPrice) / (rightPrice - leftPrice)
        : (Math.log(Math.max(price, leftPrice)) - Math.log(leftPrice)) /
          (Math.log(rightPrice) - Math.log(leftPrice));
    return clamp(leftProbability + progress * (rightProbability - leftProbability), 0, 1);
  }
  return 1;
}

function baseForecast(context: OutcomeGraphSaleContext): OutcomeGraphForecast {
  return {
    saleId: context.saleId,
    roundId: context.roundId ?? null,
    predictionId: context.predictionId ?? null,
    snapshotId: context.snapshotId ?? null,
    status: "insufficient_data",
    generatedAt: validIsoDate(context.generatedAt) ? context.generatedAt! : null,
    horizon: context.horizon ?? null,
    modelVersion: context.modelVersion ?? null,
    cohort: null,
    marketValueCents: nullableMoney(context.marketValueCents),
    startingPriceCents: nullableMoney(context.startingPriceCents),
    effectiveStartingPriceCents: nullableMoney(
      context.effectiveStartingPriceCents ?? context.startingPriceCents,
    ),
    flow: {
      heldProbability: null,
      postponedProbability: null,
      cancelledOrNotRequestedProbability: null,
      adjudicatedIfHeldProbability: null,
      noBidIfHeldProbability: null,
    },
    initialPrice: null,
    surenchereProbability: null,
    finalPrice: null,
    ceiling: null,
    pressure: null,
    confidence: null,
    delays: null,
    explanationFactors: [],
    limitations: [],
    refusalReason: null,
  };
}

function validateInputs(
  context: OutcomeGraphSaleContext,
  cohort: OutcomeGraphCohort,
): string | null {
  if (!context.saleId) return "Vente non identifiable.";
  if (!isPositiveMoney(context.startingPriceCents)) return "Mise à prix indisponible.";
  if (
    context.effectiveStartingPriceCents != null &&
    !isPositiveMoney(context.effectiveStartingPriceCents)
  ) {
    return "Mise à prix effective invalide.";
  }
  if (!cohort.trainingEligible) return "Cohorte non éligible à la prévision.";
  if (cohort.hasBlockingConflict) return "Conflit de données bloquant à résoudre.";
  if (!Number.isInteger(cohort.sampleSize) || cohort.sampleSize < MIN_AUTONOMOUS_SAMPLE) {
    return "Échantillon vérifié insuffisant : au moins 10 résultats A/B sont requis.";
  }
  if (!validIsoDate(cohort.periodStart) || !validIsoDate(cohort.periodEnd)) {
    return "Période de cohorte invalide.";
  }
  const probabilities = [
    cohort.flow.heldProbability,
    cohort.flow.postponedProbability,
    cohort.flow.cancelledOrNotRequestedProbability,
    cohort.flow.adjudicatedIfHeldProbability,
    cohort.flow.noBidIfHeldProbability,
    cohort.surenchereProbability,
    ...Object.values(cohort.delays ?? {}),
  ];
  if (probabilities.some((value) => !isProbability(value))) {
    return "Probabilités de cohorte absentes ou invalides.";
  }
  if (
    !approximatelyOne(
      cohort.flow.heldProbability! +
        cohort.flow.postponedProbability! +
        cohort.flow.cancelledOrNotRequestedProbability!,
    ) ||
    !approximatelyOne(
      cohort.flow.adjudicatedIfHeldProbability! + cohort.flow.noBidIfHeldProbability!,
    )
  ) {
    return "Probabilités conditionnelles de cohorte incohérentes.";
  }
  if (
    !validRatioQuantiles(cohort.initialPriceRatios) ||
    !validRatioQuantiles(cohort.finalPriceRatios)
  ) {
    return "Quantiles de prix absents ou non monotones.";
  }
  return null;
}

function ratioQuantiles(
  effectiveStartingPriceCents: number,
  ratios: OutcomeGraphCohort["initialPriceRatios"],
): OutcomeGraphQuantiles {
  return {
    p10Cents: money(effectiveStartingPriceCents * ratios.p10!),
    p50Cents: money(effectiveStartingPriceCents * ratios.p50!),
    p90Cents: money(effectiveStartingPriceCents * ratios.p90!),
  };
}

function confidenceForSample(sampleSize: number, tribunalSampleSize: number) {
  const label: OutcomeGraphConfidenceLabel =
    sampleSize >= 100 ? "élevé" : sampleSize >= 30 ? "moyen" : "faible";
  const score =
    label === "élevé"
      ? Math.min(0.95, 0.75 + Math.log10(sampleSize / 100 + 1) * 0.1)
      : label === "moyen"
        ? 0.58 + ((sampleSize - 30) / 70) * 0.16
        : 0.35 + ((sampleSize - 10) / 20) * 0.2;
  return {
    label,
    score: roundProbability(score),
    sampleSize,
    tribunalSampleSize: Math.max(0, Math.floor(tribunalSampleSize)),
  };
}

function competitivePressure(
  context: OutcomeGraphSaleContext,
  cohort: OutcomeGraphCohort,
): OutcomeGraphForecast["pressure"] {
  const marketValue = context.marketValueCents;
  const startingPrice = context.effectiveStartingPriceCents ?? context.startingPriceCents;
  const discountScore =
    isPositiveMoney(marketValue) && isPositiveMoney(startingPrice)
      ? score(25 + clamp(1 - startingPrice / marketValue, -0.25, 0.75) * 140)
      : null;
  const liquidityValues = [
    cohort.pressure?.liquidityScore,
    cohort.pressure?.attractivenessScore,
  ].filter(isFiniteScore);
  const liquidityScore = liquidityValues.length
    ? score(liquidityValues.reduce((sum, value) => sum + value, 0) / liquidityValues.length)
    : null;
  const components: OutcomeGraphPressureComponent[] = [
    { key: "discount", label: "Décote mise à prix / marché", score: discountScore, weight: 0.3 },
    {
      key: "adjudication",
      label: "Probabilité d’adjudication",
      score: score(cohort.flow.adjudicatedIfHeldProbability! * 100),
      weight: 0.2,
    },
    {
      key: "qualified_demand",
      label: "Demande qualifiée ImmoJudis",
      score: nullableScore(cohort.pressure?.qualifiedDemandScore),
      weight: 0.2,
    },
    {
      key: "history",
      label: "Historique tribunal / cohorte",
      score: nullableScore(cohort.pressure?.historyScore),
      weight: 0.15,
    },
    {
      key: "liquidity",
      label: "Liquidité et attractivité",
      score: liquidityScore,
      weight: 0.15,
    },
  ];
  const available = components.filter(
    (component): component is OutcomeGraphPressureComponent & { score: number } =>
      component.score != null,
  );
  const availableWeight = available.reduce((sum, component) => sum + component.weight, 0);
  if (!availableWeight) return null;
  const pressureScore = score(
    available.reduce((sum, component) => sum + component.score * component.weight, 0) /
      availableWeight,
  );
  return {
    score: pressureScore,
    label: pressureScore >= 70 ? "élevée" : pressureScore >= 40 ? "modérée" : "faible",
    coverage: roundProbability(availableWeight),
    components,
  };
}

function explanationFactors(
  context: OutcomeGraphSaleContext,
  cohort: OutcomeGraphCohort,
  pressure: OutcomeGraphForecast["pressure"],
): OutcomeGraphForecast["explanationFactors"] {
  const factors: OutcomeGraphForecast["explanationFactors"] = [
    {
      label: "Cohorte de référence",
      detail: `${cohort.label} · ${cohort.sampleSize} résultats A/B`,
      direction: "neutral",
    },
  ];
  if (isPositiveMoney(context.marketValueCents) && isPositiveMoney(context.startingPriceCents)) {
    const discountPct = Math.round(
      (1 - context.startingPriceCents / context.marketValueCents) * 100,
    );
    factors.push({
      label: "Décote de départ",
      detail: `${Math.abs(discountPct)} % ${discountPct >= 0 ? "sous" : "au-dessus de"} la valeur de marché estimée`,
      direction: discountPct >= 20 ? "up" : discountPct < 0 ? "down" : "neutral",
    });
  }
  if (pressure && pressure.coverage < 1) {
    factors.push({
      label: "Couverture de la pression",
      detail: "Certaines composantes de demande ou de liquidité restent inconnues.",
      direction: "neutral",
    });
  }
  return factors;
}

function normalizeDelays(delays: OutcomeGraphCohort["delays"]): OutcomeGraphForecast["delays"] {
  if (!delays) return null;
  return {
    heldWithin30DaysProbability: delays.heldWithin30DaysProbability ?? null,
    heldWithin60DaysProbability: delays.heldWithin60DaysProbability ?? null,
    resultKnownWithin48HoursProbability: delays.resultKnownWithin48HoursProbability ?? null,
    finalityKnownWithin15DaysProbability: delays.finalityKnownWithin15DaysProbability ?? null,
    newRoundWithin4MonthsAfterSurenchereProbability:
      delays.newRoundWithin4MonthsAfterSurenchereProbability ?? null,
  };
}

function baselineLimitations(cohort: OutcomeGraphCohort): string[] {
  return [
    "Prévision statistique, pas une garantie de déroulement ni de prix.",
    "Le plafond privé sert uniquement au calcul affiché et n’entre pas dans les cohortes.",
    `Cohorte ${cohort.label}, période ${cohort.periodStart.slice(0, 10)} – ${cohort.periodEnd.slice(0, 10)}.`,
  ];
}

function cohortMetadata(cohort: OutcomeGraphCohort) {
  return {
    id: cohort.id,
    label: cohort.label,
    level: cohort.level,
    periodStart: cohort.periodStart,
    periodEnd: cohort.periodEnd,
  };
}

function validRatioQuantiles(quantiles: OutcomeGraphCohort["initialPriceRatios"]): boolean {
  return (
    isPositiveNumber(quantiles.p10) &&
    isPositiveNumber(quantiles.p50) &&
    isPositiveNumber(quantiles.p90) &&
    quantiles.p10 <= quantiles.p50 &&
    quantiles.p50 <= quantiles.p90
  );
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isFiniteScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function nullableScore(value: unknown): number | null {
  return isFiniteScore(value) ? score(value) : null;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPositiveMoney(value: unknown): value is number {
  return isPositiveNumber(value) && Number.isSafeInteger(value);
}

function nullableMoney(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function money(value: number): number {
  return Math.max(0, Math.round(value));
}

function score(value: number): number {
  return Math.round(clamp(value, 0, 100));
}

function roundProbability(value: number): number {
  return Math.round(clamp(value, 0, 1) * 10_000) / 10_000;
}

function approximatelyOne(value: number): boolean {
  return Math.abs(value - 1) <= 0.02;
}

function validIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
