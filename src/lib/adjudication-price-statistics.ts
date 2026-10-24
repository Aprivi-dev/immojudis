// zod/mini : les réponses sont validées dans le navigateur (`adjudication-price-statistics-client`).
// Mêmes règles que l'écriture chaînée de zod, avec bien moins de code envoyé au navigateur.
import { z } from "zod/mini";
import {
  adjudicationDistributionSchema,
  propertyTypeDistributionsSchema,
} from "@/lib/adjudication-distributions";

const isoDateSchema = z.string().check(z.iso.date());
const isoDateTimeSchema = z.string().check(z.iso.datetime({ offset: true }));
const probabilitySchema = z.number().check(z.gte(0), z.lte(1));
// Un nombre fini (zod 4 refuse déjà l'infini) et strictement positif.
const positiveNumber = () => z.number().check(z.positive());
const label = () => z.string().check(z.minLength(1));

export const ADJUDICATION_PRICE_STATISTICS_WARNING =
  "Source tierce non officielle : prix publiés par Licitor, non vérifiés auprès du greffe et non présentés comme définitifs. Agrégats descriptifs uniquement, sans valeur prédictive ni estimation du bien.";

export const adjudicationPriceStatisticsReliabilitySchema = z.enum([
  "limited",
  "descriptive",
  "extended",
]);

export const adjudicationPriceStatisticsScopeSchema = z
  .strictObject({
    scopeType: z.enum(["national", "tribunal"]),
    label: label(),
    courtCode: z.nullable(label()),
    judicialRegion: z.nullable(label()),
    periodStart: isoDateSchema,
    periodEnd: isoDateSchema,
    sampleSize: z.number().check(z.int(), z.gte(10)),
    reliability: adjudicationPriceStatisticsReliabilitySchema,
    distribution: z.optional(z.nullable(adjudicationDistributionSchema)),
    propertyTypes: z.optional(propertyTypeDistributionsSchema),
    metrics: z.strictObject({
      medianHammerToStartingRatio: positiveNumber(),
      aboveStartingRate: probabilitySchema,
      atLeastDoubleRate: probabilitySchema,
      medianHammerPriceEur: positiveNumber(),
      medianStartingPriceEur: positiveNumber(),
    }),
  })
  .check(
    z.refine(
      (scope) => !scope.distribution || scope.distribution.sampleSize === scope.sampleSize,
      "La répartition doit correspondre au même échantillon",
    ),
    z.refine(
      (scope) =>
        (scope.propertyTypes ?? []).reduce((sum, item) => sum + item.distribution.sampleSize, 0) <=
        scope.sampleSize,
      "Les sous-échantillons dépassent le total",
    ),
    z.superRefine((scope, context) => {
      const fail = (message: string) => context.addIssue({ code: "custom", message });
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
    }),
  );

export const adjudicationPriceStatisticsResponseSchema = z.strictObject({
  national: adjudicationPriceStatisticsScopeSchema,
  tribunal: z.nullable(adjudicationPriceStatisticsScopeSchema),
  meta: z.strictObject({
    sourceName: z.literal("licitor"),
    sourceLabel: z.literal("Résultats d’adjudication publiés par Licitor"),
    methodologyVersion: z.literal("licitor_canonical_price_statistics_v1"),
    builtAt: isoDateTimeSchema,
    reviewedAt: isoDateTimeSchema,
    experimental: z.literal(true),
    warning: z.literal(ADJUDICATION_PRICE_STATISTICS_WARNING),
  }),
});

export const adjudicationPriceStatisticsDirectoryResponseSchema = z
  .strictObject({
    national: adjudicationPriceStatisticsScopeSchema,
    tribunals: z.array(adjudicationPriceStatisticsScopeSchema).check(z.maxLength(250)),
    meta: adjudicationPriceStatisticsResponseSchema.shape.meta,
  })
  .check(
    z.superRefine((value, context) => {
      if (value.national.scopeType !== "national") {
        context.addIssue({
          code: "custom",
          path: ["national"],
          message: "National scope required",
        });
      }
      const codes = new Set<string>();
      if (
        value.tribunals.reduce((sum, item) => sum + item.sampleSize, 0) > value.national.sampleSize
      ) {
        context.addIssue({
          code: "custom",
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
            code: "custom",
            path: ["tribunals", index],
            message: "La comparaison exige une période identique",
          });
        }
        if (tribunal.scopeType !== "tribunal" || !tribunal.courtCode) {
          context.addIssue({
            code: "custom",
            path: ["tribunals", index],
            message: "Exact tribunal scope required",
          });
        }
        if (tribunal.courtCode && codes.has(tribunal.courtCode)) {
          context.addIssue({
            code: "custom",
            path: ["tribunals", index],
            message: "Duplicate tribunal",
          });
        }
        if (tribunal.courtCode) codes.add(tribunal.courtCode);
      }
    }),
  );

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
