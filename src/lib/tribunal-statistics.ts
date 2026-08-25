import { z } from "zod";

const nonNegativeIntegerSchema = z.number().int().nonnegative();
const probabilitySchema = z.number().min(0).max(1);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoDateTimeSchema = z.string().datetime({ offset: true });

export const TRIBUNAL_STATISTICS_BUILDER_VERSION = "tribunal_statistics_builder_v1" as const;
export const TRIBUNAL_STATISTICS_ELIGIBILITY_RULE_VERSION =
  "claim_ab_reviewed_frozen_round_as_of_v1" as const;
export const TRIBUNAL_STATISTICS_SMOOTHING_RULE_VERSION = "jeffreys_beta_log_shrinkage_v1" as const;

export const TRIBUNAL_STATISTICS_WARNING = {
  HISTORICAL: "Statistiques descriptives historiques, pas une prédiction individuelle.",
  VERIFIED_EVIDENCE_ONLY: "Seules les preuves A/B validées pour chaque champ sont comptées.",
  DEFINITIVE_PRICE_REQUIRED:
    "Le ratio de prix exige un prix final procéduralement définitif; le prix initial d’adjudication ne le remplace jamais.",
  UNSUPPORTED_CELLS:
    "Ratio au marché et délai vers la prochaine audience masqués faute de preuve canonique dédiée.",
  SAMPLE_BELOW_10: "Échantillon inférieur à 10: toutes les valeurs de la cellule sont masquées.",
  REVIEW_GATE_FAILED:
    "Contrôle qualité non atteint: 20 % des 500 premiers résultats vérifiés doivent être relus indépendamment.",
  OUTCOME_COVERAGE_LOW: "Couverture des résultats inférieure à 80 %: niveau robuste interdit.",
  FREEZE_COVERAGE_FAILED:
    "Couverture du gel antérieur au cutoff inférieure à 80 %: publication supprimée.",
  NATIONAL_REFERENCE_UNPUBLISHABLE:
    "Référence nationale non publiable: toutes les valeurs locales sont masquées.",
  LOCAL_WEIGHT_SCOPE:
    "Le poids local affiché concerne l’échantillon de statuts; chaque cellule conserve son propre dénominateur.",
  ROUND_NOT_FROZEN: "round_not_frozen_at_cutoff",
} as const;

// Stored warnings are deliberately closed: otherwise a service-role writer
// could smuggle a small exact count (or arbitrary prose) through this public
// array even when every metric cell is correctly suppressed.
export const tribunalStatisticsStoredWarningSchema = z.enum([
  TRIBUNAL_STATISTICS_WARNING.HISTORICAL,
  TRIBUNAL_STATISTICS_WARNING.VERIFIED_EVIDENCE_ONLY,
  TRIBUNAL_STATISTICS_WARNING.DEFINITIVE_PRICE_REQUIRED,
  TRIBUNAL_STATISTICS_WARNING.UNSUPPORTED_CELLS,
  TRIBUNAL_STATISTICS_WARNING.SAMPLE_BELOW_10,
  TRIBUNAL_STATISTICS_WARNING.REVIEW_GATE_FAILED,
  TRIBUNAL_STATISTICS_WARNING.OUTCOME_COVERAGE_LOW,
  TRIBUNAL_STATISTICS_WARNING.FREEZE_COVERAGE_FAILED,
  TRIBUNAL_STATISTICS_WARNING.NATIONAL_REFERENCE_UNPUBLISHABLE,
  TRIBUNAL_STATISTICS_WARNING.LOCAL_WEIGHT_SCOPE,
  TRIBUNAL_STATISTICS_WARNING.ROUND_NOT_FROZEN,
]);

export const TRIBUNAL_STATISTICS_EXCLUSION_REASONS = [
  "no_terminal_outcome_at_cutoff",
  "ambiguous_terminal_outcome",
  "outcome_status_claim_ineligible",
  "unsupported_outcome_status",
  "surenchere_status_claim_ineligible",
  "initial_starting_price_eur_claim_ineligible",
  "effective_starting_price_eur_claim_ineligible",
  "final_hammer_price_claim_ineligible",
  "finality_status_claim_ineligible",
  "non_positive_price",
  "result_observed_at_claim_ineligible",
  "result_observed_after_cutoff",
  "result_observed_before_hearing",
] as const;

export const tribunalStatisticsExclusionReasonSchema = z.enum(
  TRIBUNAL_STATISTICS_EXCLUSION_REASONS,
);

const tribunalStatisticsExclusionReasonsSchema = z
  .record(z.string().min(1), nonNegativeIntegerSchema)
  .superRefine((reasons, context) => {
    for (const reason of Object.keys(reasons)) {
      if (!tribunalStatisticsExclusionReasonSchema.safeParse(reason).success) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [reason],
          message: "Motif d’exclusion absent de l’allowlist publique v1.",
        });
      }
    }
  })
  .default({});

export const tribunalStatisticsWindowMonthsSchema = z.union([
  z.literal(12),
  z.literal(24),
  z.literal(36),
]);

export const tribunalStatisticsReliabilitySchema = z.enum([
  "insufficient_data",
  "smoothed",
  "descriptive",
  "robust",
]);

export const tribunalStatisticsAdjustmentMethodSchema = z.enum([
  "suppressed",
  "raw",
  "beta_binomial",
  "national_fallback",
  "log_shrinkage",
]);

export const tribunalStatisticsRateMethodSchema = z.enum([
  "raw",
  "beta_binomial",
  "national_fallback",
]);

export const tribunalStatisticsDistributionMethodSchema = z.enum([
  "raw",
  "national_fallback",
  "log_shrinkage",
]);

export const tribunalStatisticsConfidenceIntervalSchema = z
  .object({
    low: probabilitySchema,
    high: probabilitySchema,
  })
  .strict()
  .superRefine((interval, context) => {
    if (interval.low > interval.high) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "La borne basse doit être inférieure ou égale à la borne haute.",
      });
    }
  });

const publishedTribunalStatisticsMetricSchema = z
  .object({
    rawValue: probabilitySchema,
    adjustedValue: probabilitySchema,
    numerator: nonNegativeIntegerSchema,
    knownDenominator: nonNegativeIntegerSchema,
    eligibleUniverse: nonNegativeIntegerSchema,
    unknownCount: nonNegativeIntegerSchema,
    excludedCount: nonNegativeIntegerSchema,
    exclusionReasons: tribunalStatisticsExclusionReasonsSchema,
    confidenceInterval: tribunalStatisticsConfidenceIntervalSchema,
    method: tribunalStatisticsRateMethodSchema,
  })
  .strict()
  .superRefine((metric, context) => {
    if (metric.numerator > metric.knownDenominator) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["numerator"],
        message: "Le numérateur ne peut pas dépasser le dénominateur connu.",
      });
    }
    if (
      metric.knownDenominator + metric.unknownCount + metric.excludedCount !==
      metric.eligibleUniverse
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unknownCount"],
        message: "Les observations connues, inconnues et exclues doivent partitionner l’univers.",
      });
    }
    const exclusionReasonTotal = Object.values(metric.exclusionReasons).reduce(
      (total, count) => total + count,
      0,
    );
    if (exclusionReasonTotal !== metric.excludedCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exclusionReasons"],
        message: "Le détail des exclusions doit correspondre au total exclu.",
      });
    }
    if (
      metric.knownDenominator === 0 ||
      Math.abs(metric.rawValue - metric.numerator / metric.knownDenominator) > 0.000001
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rawValue"],
        message: "La valeur brute doit correspondre exactement au ratio numérateur/dénominateur.",
      });
    }
    if (metric.knownDenominator < 10) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["method"],
        message: "Une cellule de moins de 10 observations doit rester entièrement masquée.",
      });
    }
    if (
      metric.knownDenominator >= 10 &&
      metric.knownDenominator < 30 &&
      !["beta_binomial", "national_fallback"].includes(metric.method)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["method"],
        message: "Une proportion fondée sur 10 à 29 observations doit être fortement lissée.",
      });
    }
  });

const suppressedTribunalStatisticsMetricSchema = z
  .object({
    rawValue: z.null(),
    adjustedValue: z.null(),
    numerator: z.null(),
    knownDenominator: z.null(),
    eligibleUniverse: z.null(),
    unknownCount: z.null(),
    excludedCount: z.null(),
    exclusionReasons: tribunalStatisticsExclusionReasonsSchema,
    confidenceInterval: z.null(),
    method: z.literal("suppressed"),
  })
  .strict()
  .superRefine((metric, context) => {
    if (Object.keys(metric.exclusionReasons).length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exclusionReasons"],
        message: "Une cellule supprimée ne doit exposer aucun motif chiffré.",
      });
    }
  });

export const tribunalStatisticsMetricSchema = z.union([
  suppressedTribunalStatisticsMetricSchema,
  publishedTribunalStatisticsMetricSchema,
]);

export const tribunalStatisticsQuantilesSchema = z
  .object({
    p10: z.number().nonnegative(),
    p50: z.number().nonnegative(),
    p90: z.number().nonnegative(),
  })
  .strict()
  .superRefine((quantiles, context) => {
    if (quantiles.p10 > quantiles.p50 || quantiles.p50 > quantiles.p90) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Les quantiles doivent être monotones (P10 ≤ P50 ≤ P90).",
      });
    }
  });

const publishedTribunalStatisticsDistributionSchema = z
  .object({
    sampleSize: nonNegativeIntegerSchema,
    eligibleUniverse: nonNegativeIntegerSchema,
    unknownCount: nonNegativeIntegerSchema,
    raw: tribunalStatisticsQuantilesSchema,
    adjusted: tribunalStatisticsQuantilesSchema,
    method: tribunalStatisticsDistributionMethodSchema,
    parentSampleSize: nonNegativeIntegerSchema,
    excludedCount: nonNegativeIntegerSchema,
    exclusionReasons: tribunalStatisticsExclusionReasonsSchema,
  })
  .strict()
  .superRefine((distribution, context) => {
    if (
      distribution.sampleSize + distribution.unknownCount + distribution.excludedCount !==
      distribution.eligibleUniverse
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unknownCount"],
        message: "Les échantillons connus, inconnus et exclus doivent partitionner l’univers.",
      });
    }
    const exclusionReasonTotal = Object.values(distribution.exclusionReasons).reduce(
      (total, count) => total + count,
      0,
    );
    if (exclusionReasonTotal !== distribution.excludedCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exclusionReasons"],
        message: "Le détail des exclusions doit correspondre au total exclu.",
      });
    }
    if (distribution.sampleSize < 10) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["method"],
        message: "Une distribution de moins de 10 observations doit rester entièrement masquée.",
      });
    }
    if (
      distribution.sampleSize >= 10 &&
      distribution.sampleSize < 30 &&
      !["log_shrinkage", "national_fallback"].includes(distribution.method)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["method"],
        message: "Une distribution fondée sur 10 à 29 observations doit être fortement lissée.",
      });
    }
  });

const suppressedTribunalStatisticsDistributionSchema = z
  .object({
    sampleSize: z.null(),
    eligibleUniverse: z.null(),
    unknownCount: z.null(),
    raw: z.null(),
    adjusted: z.null(),
    method: z.literal("suppressed"),
    parentSampleSize: z.null(),
    excludedCount: z.null(),
    exclusionReasons: tribunalStatisticsExclusionReasonsSchema,
  })
  .strict()
  .superRefine((distribution, context) => {
    if (Object.keys(distribution.exclusionReasons).length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exclusionReasons"],
        message: "Une distribution supprimée ne doit exposer aucun motif chiffré.",
      });
    }
  });

export const tribunalStatisticsDistributionSchema = z.union([
  suppressedTribunalStatisticsDistributionSchema,
  publishedTribunalStatisticsDistributionSchema,
]);

export const tribunalStatisticsPayloadSchema = z
  .object({
    flow: z
      .object({
        held: tribunalStatisticsMetricSchema,
        postponed: tribunalStatisticsMetricSchema,
        cancelled: tribunalStatisticsMetricSchema,
        notRequested: tribunalStatisticsMetricSchema,
        noBidIfHeld: tribunalStatisticsMetricSchema,
        adjudicatedIfHeld: tribunalStatisticsMetricSchema,
      })
      .strict(),
    surenchere: z
      .object({
        filed: tribunalStatisticsMetricSchema,
      })
      .strict(),
    priceRatios: z
      .object({
        finalToInitial: tribunalStatisticsDistributionSchema,
        finalToEffective: tribunalStatisticsDistributionSchema,
        finalToMarket: tribunalStatisticsDistributionSchema,
      })
      .strict(),
    delays: z
      .object({
        hearingToKnownResult: tribunalStatisticsDistributionSchema,
        postponementToNextHearing: tribunalStatisticsDistributionSchema,
      })
      .strict(),
    fallback: z
      .object({
        scope: z.enum(["none", "national"]),
        parentLabel: z.string().min(1).nullable(),
        localWeight: probabilitySchema,
      })
      .strict()
      .superRefine((fallback, context) => {
        if (fallback.scope === "none" && fallback.parentLabel !== null) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["parentLabel"],
            message: "Un calcul sans fallback ne doit pas nommer de référence parente.",
          });
        }
        if (fallback.scope === "national" && fallback.parentLabel === null) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["parentLabel"],
            message: "Un fallback national doit nommer sa référence publique.",
          });
        }
        if (fallback.scope === "none" && fallback.localWeight !== 1) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["localWeight"],
            message: "Un calcul sans fallback doit avoir un poids local de 1.",
          });
        }
      }),
    warnings: z.array(tribunalStatisticsStoredWarningSchema),
  })
  .strict();

export const tribunalStatisticsItemSchema = z
  .object({
    scope: z.enum(["national", "tribunal"]),
    tribunal: z
      .object({
        code: z.string().min(1),
        name: z.string().min(1),
        judicialRegion: z.string().min(1).nullable(),
      })
      .strict()
      .nullable(),
    roundKind: z.literal("initial"),
    period: z
      .object({
        start: isoDateSchema,
        end: isoDateSchema,
        windowMonths: tribunalStatisticsWindowMonthsSchema,
        knowledgeCutoffAt: isoDateTimeSchema,
      })
      .strict(),
    reliability: z
      .object({
        level: tribunalStatisticsReliabilitySchema,
        label: z.string().min(1),
        qualityGatePassed: z.boolean(),
        coverage: probabilitySchema.nullable(),
        warnings: z.array(z.string().min(1)),
      })
      .strict(),
    samples: z
      .object({
        eligibleRounds: nonNegativeIntegerSchema.nullable(),
        status: nonNegativeIntegerSchema.nullable(),
        initialPrice: nonNegativeIntegerSchema.nullable(),
        effectivePrice: nonNegativeIntegerSchema.nullable(),
        marketPrice: nonNegativeIntegerSchema.nullable(),
        surenchere: nonNegativeIntegerSchema.nullable(),
        resultDelay: nonNegativeIntegerSchema.nullable(),
        postponementDelay: nonNegativeIntegerSchema.nullable(),
        doubleReviewed: nonNegativeIntegerSchema.nullable(),
      })
      .strict(),
    flow: tribunalStatisticsPayloadSchema.shape.flow,
    surenchere: tribunalStatisticsPayloadSchema.shape.surenchere,
    priceRatios: tribunalStatisticsPayloadSchema.shape.priceRatios,
    delays: tribunalStatisticsPayloadSchema.shape.delays,
    fallback: tribunalStatisticsPayloadSchema.shape.fallback,
    methodology: z
      .object({
        builderVersion: z.literal(TRIBUNAL_STATISTICS_BUILDER_VERSION),
        eligibilityRuleVersion: z.literal(TRIBUNAL_STATISTICS_ELIGIBILITY_RULE_VERSION),
        smoothingRuleVersion: z.literal(TRIBUNAL_STATISTICS_SMOOTHING_RULE_VERSION),
      })
      .strict(),
    limitations: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((item, context) => {
    if ((item.scope === "national") !== (item.tribunal === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tribunal"],
        message: "Le périmètre national ne doit pas contenir de tribunal.",
      });
    }
    if (
      item.scope === "national" &&
      (item.fallback.scope !== "none" || item.fallback.localWeight !== 1)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fallback"],
        message: "La référence nationale ne peut pas se replier sur elle-même.",
      });
    }
    const publishedMetrics = [...Object.values(item.flow), item.surenchere.filed].filter(
      (metric) => metric.method !== "suppressed",
    );
    const publishedDistributions = [
      ...Object.values(item.priceRatios),
      ...Object.values(item.delays),
    ].filter((distribution) => distribution.method !== "suppressed");
    const usesNationalFallback = [...publishedMetrics, ...publishedDistributions].some(
      (cell) => cell.method === "national_fallback",
    );
    if (usesNationalFallback && (item.scope === "national" || item.fallback.scope !== "national")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fallback"],
        message:
          "Une méthode national_fallback exige une entrée tribunal et une référence nationale.",
      });
    }
    for (const distribution of publishedDistributions) {
      if (
        (distribution.method === "national_fallback" ||
          (item.scope === "tribunal" && distribution.method === "log_shrinkage")) &&
        distribution.parentSampleSize === 0
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fallback"],
          message: "Un ajustement vers la référence nationale exige un échantillon parent.",
        });
      }
      if (item.scope === "national" && distribution.parentSampleSize !== 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fallback"],
          message: "La référence nationale ne peut déclarer un échantillon parent.",
        });
      }
    }
    if (
      item.samples.status !== null &&
      item.samples.eligibleRounds !== null &&
      item.samples.status > item.samples.eligibleRounds
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["samples", "status"],
        message: "L’échantillon de statuts dépasse l’univers d’audiences.",
      });
    }
    const publicSamples = {
      eligibleRounds: item.samples.eligibleRounds,
      status: item.samples.status,
      initialPrice: item.samples.initialPrice,
      effectivePrice: item.samples.effectivePrice,
      marketPrice: item.samples.marketPrice,
      surenchere: item.samples.surenchere,
      resultDelay: item.samples.resultDelay,
      postponementDelay: item.samples.postponementDelay,
      doubleReviewed: item.samples.doubleReviewed,
    };
    for (const [sampleName, sampleSize] of Object.entries(publicSamples)) {
      if (sampleSize !== null && sampleSize < 10) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["samples", sampleName],
          message: "Un effectif public inférieur à 10 doit être masqué.",
        });
      }
    }
    for (const [sampleName, sampleSize] of Object.entries({
      initialPrice: item.samples.initialPrice,
      effectivePrice: item.samples.effectivePrice,
      marketPrice: item.samples.marketPrice,
      surenchere: item.samples.surenchere,
      resultDelay: item.samples.resultDelay,
      postponementDelay: item.samples.postponementDelay,
      doubleReviewed: item.samples.doubleReviewed,
    })) {
      if (sampleSize !== null && item.samples.status !== null && sampleSize > item.samples.status) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["samples", sampleName],
          message: "Un sous-échantillon métrique ne peut pas dépasser les statuts admissibles.",
        });
      }
    }
    if (item.samples.eligibleRounds !== null && item.samples.status !== null) {
      const expectedCoverage =
        item.samples.eligibleRounds === 0 ? 0 : item.samples.status / item.samples.eligibleRounds;
      if (
        item.reliability.coverage === null ||
        Math.abs(item.reliability.coverage - expectedCoverage) > 0.000001
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reliability", "coverage"],
          message: "La couverture doit correspondre aux statuts connus sur l’univers d’audiences.",
        });
      }
    } else if (item.reliability.coverage !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reliability", "coverage"],
        message: "Une couverture dont les effectifs sont masqués doit elle aussi être masquée.",
      });
    }
    if (item.samples.status !== null && item.reliability.coverage !== null) {
      const expectedLevel = reliabilityForSample(
        item.samples.status,
        item.reliability.qualityGatePassed,
        item.reliability.coverage,
      );
      if (item.reliability.level !== expectedLevel) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reliability", "level"],
          message: "Le niveau de fiabilité ne respecte pas les seuils d’échantillon et de qualité.",
        });
      }
    }
    const minimumDoubleReviews =
      item.samples.status === null ? null : Math.ceil(Math.min(item.samples.status, 500) * 0.2);
    if (
      item.reliability.qualityGatePassed &&
      minimumDoubleReviews !== null &&
      item.samples.doubleReviewed !== null &&
      item.samples.doubleReviewed < minimumDoubleReviews
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["samples", "doubleReviewed"],
        message:
          "Le contrôle qualité exige au moins 20 % de double revue sur les 500 premiers résultats.",
      });
    }
    if (!item.reliability.qualityGatePassed) {
      const metrics = [...Object.values(item.flow), item.surenchere.filed];
      const distributions = [...Object.values(item.priceRatios), ...Object.values(item.delays)];
      if (
        metrics.some((metric) => metric.method !== "suppressed") ||
        distributions.some((distribution) => distribution.method !== "suppressed")
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reliability", "qualityGatePassed"],
          message: "Un contrôle qualité non franchi doit supprimer toutes les valeurs publiables.",
        });
      }
    }
  });

export const tribunalStatisticsResponseSchema = z
  .object({
    national: tribunalStatisticsItemSchema,
    tribunals: z.array(tribunalStatisticsItemSchema),
    meta: z
      .object({
        generatedAt: isoDateTimeSchema,
        experimental: z.literal(true),
        windowMonths: tribunalStatisticsWindowMonthsSchema,
        roundKind: z.literal("initial"),
        warnings: z.array(z.string().min(1)),
      })
      .strict(),
  })
  .strict()
  .superRefine((response, context) => {
    if (response.national.scope !== "national") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["national", "scope"],
        message: "La référence nationale doit avoir le périmètre national.",
      });
    }
    for (const [index, item] of response.tribunals.entries()) {
      if (item.scope !== "tribunal") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tribunals", index, "scope"],
          message: "Une entrée tribunal doit avoir le périmètre tribunal.",
        });
      }
      const comparisonFields = [
        ["roundKind", item.roundKind, response.national.roundKind],
        ["period.start", item.period.start, response.national.period.start],
        ["period.end", item.period.end, response.national.period.end],
        ["period.windowMonths", item.period.windowMonths, response.national.period.windowMonths],
        [
          "period.knowledgeCutoffAt",
          item.period.knowledgeCutoffAt,
          response.national.period.knowledgeCutoffAt,
        ],
        [
          "methodology.builderVersion",
          item.methodology.builderVersion,
          response.national.methodology.builderVersion,
        ],
        [
          "methodology.eligibilityRuleVersion",
          item.methodology.eligibilityRuleVersion,
          response.national.methodology.eligibilityRuleVersion,
        ],
        [
          "methodology.smoothingRuleVersion",
          item.methodology.smoothingRuleVersion,
          response.national.methodology.smoothingRuleVersion,
        ],
      ] as const;
      for (const [field, actual, expected] of comparisonFields) {
        if (actual !== expected) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["tribunals", index],
            message: `${field} doit être identique à la référence nationale.`,
          });
        }
      }
    }
    if (response.meta.windowMonths !== response.national.period.windowMonths) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meta", "windowMonths"],
        message: "La fenêtre de réponse doit correspondre à la référence nationale.",
      });
    }
    if (response.national.roundKind !== response.meta.roundKind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meta", "roundKind"],
        message: "Le type de round doit correspondre à la référence nationale.",
      });
    }
  });

function reliabilityForSample(
  sampleSize: number,
  qualityGatePassed: boolean,
  coverage: number,
): TribunalStatisticsReliability {
  if (!qualityGatePassed || sampleSize < 10) return "insufficient_data";
  if (sampleSize < 30) return "smoothed";
  if (sampleSize < 100 || coverage < 0.8) return "descriptive";
  return "robust";
}

export type TribunalStatisticsWindowMonths = z.infer<typeof tribunalStatisticsWindowMonthsSchema>;
export type TribunalStatisticsExclusionReason = z.infer<
  typeof tribunalStatisticsExclusionReasonSchema
>;
export type TribunalStatisticsReliability = z.infer<typeof tribunalStatisticsReliabilitySchema>;
export type TribunalStatisticsAdjustmentMethod = z.infer<
  typeof tribunalStatisticsAdjustmentMethodSchema
>;
export type TribunalStatisticsMetric = z.infer<typeof tribunalStatisticsMetricSchema>;
export type TribunalStatisticsDistribution = z.infer<typeof tribunalStatisticsDistributionSchema>;
export type TribunalStatisticsPayload = z.infer<typeof tribunalStatisticsPayloadSchema>;
export type TribunalStatisticsItem = z.infer<typeof tribunalStatisticsItemSchema>;
export type TribunalStatisticsResponse = z.infer<typeof tribunalStatisticsResponseSchema>;
