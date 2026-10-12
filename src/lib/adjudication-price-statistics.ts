import { z } from "zod";
import {
  adjudicationDistributionSchema,
  propertyTypeDistributionsSchema,
} from "@/lib/adjudication-distributions";

const isoDateSchema = z.string().date();
const isoDateTimeSchema = z.string().datetime({ offset: true });
const probabilitySchema = z.number().min(0).max(1);

export const ADJUDICATION_PRICE_STATISTICS_WARNING =
  "Source tierce non officielle : prix publiés par Licitor, non vérifiés auprès du greffe et non présentés comme définitifs. Agrégats descriptifs uniquement, sans valeur prédictive ni estimation du bien.";

export const adjudicationPriceStatisticsReliabilitySchema = z.enum([
  "limited",
  "descriptive",
  "extended",
]);

export const adjudicationPriceStatisticsScopeSchema = z
  .object({
    scopeType: z.enum(["national", "tribunal"]),
    label: z.string().min(1),
    courtCode: z.string().min(1).nullable(),
    judicialRegion: z.string().min(1).nullable(),
    periodStart: isoDateSchema,
    periodEnd: isoDateSchema,
    sampleSize: z.number().int().min(10),
    reliability: adjudicationPriceStatisticsReliabilitySchema,
    distribution: adjudicationDistributionSchema.nullable().optional(),
    propertyTypes: propertyTypeDistributionsSchema.optional(),
    metrics: z
      .object({
        medianHammerToStartingRatio: z.number().finite().positive(),
        aboveStartingRate: probabilitySchema,
        atLeastDoubleRate: probabilitySchema,
        medianHammerPriceEur: z.number().finite().positive(),
        medianStartingPriceEur: z.number().finite().positive(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (scope) => !scope.distribution || scope.distribution.sampleSize === scope.sampleSize,
    "La répartition doit correspondre au même échantillon",
  )
  .refine(
    (scope) =>
      (scope.propertyTypes ?? []).reduce((sum, item) => sum + item.distribution.sampleSize, 0) <=
      scope.sampleSize,
    "Les sous-échantillons dépassent le total",
  )
  .superRefine((scope, context) => {
    const fail = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
    if (scope.periodStart > scope.periodEnd) fail("Période inversée");
    if (scope.metrics.atLeastDoubleRate > scope.metrics.aboveStartingRate + 0.000001) {
      fail("La part au moins double dépasse la part au-dessus de la mise");
    }
    if (scope.distribution) {
      const bins = scope.distribution.bidDistribution;
      const count = (band: string) => bins.find((bin) => bin.band === band)?.count ?? 0;
      const above =
        (scope.sampleSize - count("below_starting") - count("at_starting")) / scope.sampleSize;
      if (
        Math.abs(scope.metrics.aboveStartingRate - above) > 0.000001 ||
        Math.abs(scope.metrics.atLeastDoubleRate - count("at_least_2") / scope.sampleSize) >
          0.000001
      ) {
        fail("Les taux ne correspondent pas à la répartition publiée");
      }
      const summary = scope.distribution.summary;
      if (
        summary &&
        (Math.abs(scope.metrics.medianHammerPriceEur - summary.medianHammerPriceEur) > 1 ||
          Math.abs(scope.metrics.medianStartingPriceEur - summary.medianStartingPriceEur) > 1 ||
          Math.abs(
            scope.metrics.medianHammerToStartingRatio - summary.medianHammerToStartingRatio,
          ) > 0.0001)
      )
        fail("Les médianes ne correspondent pas au même échantillon");
    }
  });

export const adjudicationPriceStatisticsResponseSchema = z
  .object({
    national: adjudicationPriceStatisticsScopeSchema,
    tribunal: adjudicationPriceStatisticsScopeSchema.nullable(),
    meta: z
      .object({
        sourceName: z.literal("licitor"),
        sourceLabel: z.literal("Résultats d’adjudication publiés par Licitor"),
        methodologyVersion: z.literal("licitor_canonical_price_statistics_v1"),
        builtAt: isoDateTimeSchema,
        reviewedAt: isoDateTimeSchema,
        experimental: z.literal(true),
        warning: z.literal(ADJUDICATION_PRICE_STATISTICS_WARNING),
      })
      .strict(),
  })
  .strict();

export const adjudicationPriceStatisticsDirectoryResponseSchema = z
  .object({
    national: adjudicationPriceStatisticsScopeSchema,
    tribunals: z.array(adjudicationPriceStatisticsScopeSchema).max(250),
    meta: adjudicationPriceStatisticsResponseSchema.shape.meta,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.national.scopeType !== "national") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["national"],
        message: "National scope required",
      });
    }
    const codes = new Set<string>();
    if (
      value.tribunals.reduce((sum, item) => sum + item.sampleSize, 0) > value.national.sampleSize
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tribunals"],
        message: "Les effectifs des tribunaux dépassent l’échantillon national",
      });
    }
    for (const [index, tribunal] of value.tribunals.entries()) {
      if (
        tribunal.periodStart !== value.national.periodStart ||
        tribunal.periodEnd !== value.national.periodEnd
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tribunals", index],
          message: "La comparaison exige une période identique",
        });
      }
      if (tribunal.scopeType !== "tribunal" || !tribunal.courtCode) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tribunals", index],
          message: "Exact tribunal scope required",
        });
      }
      if (tribunal.courtCode && codes.has(tribunal.courtCode)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tribunals", index],
          message: "Duplicate tribunal",
        });
      }
      if (tribunal.courtCode) codes.add(tribunal.courtCode);
    }
  });

export type AdjudicationPriceStatisticsScope = z.infer<
  typeof adjudicationPriceStatisticsScopeSchema
>;
export type AdjudicationPriceStatisticsResponse = z.infer<
  typeof adjudicationPriceStatisticsResponseSchema
>;
export type AdjudicationPriceStatisticsDirectoryResponse = z.infer<
  typeof adjudicationPriceStatisticsDirectoryResponseSchema
>;

export function adjudicationPriceStatisticsReliability(
  sampleSize: number,
): AdjudicationPriceStatisticsScope["reliability"] {
  if (sampleSize >= 100) return "extended";
  if (sampleSize >= 30) return "descriptive";
  return "limited";
}
