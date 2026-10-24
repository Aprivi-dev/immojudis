// zod/mini : ces schémas valident aussi, dans le navigateur, les statistiques reçues par le
// baromètre et la fiche. Mêmes règles que l'écriture chaînée de zod (objets `strict` devenus
// `strictObject`, `.refine` devenu `.check(z.refine(...))`), avec bien moins de code envoyé.
import { z } from "zod/mini";

export const bidBands = [
  "below_starting",
  "at_starting",
  "above_1_below_1_5",
  "from_1_5_below_2",
  "at_least_2",
] as const;

// Un nombre fini (zod 4 refuse déjà l'infini) et strictement positif.
const positiveNumber = () => z.number().check(z.positive());

const range = z
  .strictObject({ p25: positiveNumber(), p75: positiveNumber() })
  .check(z.refine((value) => value.p25 <= value.p75, "Quartiles inversés"));

// Optional additions keep already reviewed, immutable snapshots readable.
export const detailedBidBands = [
  "below_starting",
  "at_starting",
  "above_1_below_1_5",
  "from_1_5_below_2",
  "from_2_below_3",
  "at_least_3",
] as const;

const summarySchema = z.strictObject({
  medianHammerPriceEur: positiveNumber(),
  medianStartingPriceEur: positiveNumber(),
  medianHammerToStartingRatio: positiveNumber(),
  meanHammerToStartingRatio: positiveNumber(),
});

export const adjudicationDistributionSchema = z
  .strictObject({
    sampleSize: z.number().check(z.int(), z.gte(10)),
    hammerPriceMiddle50Eur: range,
    ratioMiddle50: range,
    summary: z.optional(summarySchema),
    detailedBidDistribution: z.optional(
      z
        .array(
          z.strictObject({
            band: z.enum(detailedBidBands),
            count: z.number().check(z.int(), z.nonnegative()),
            share: z.number().check(z.gte(0), z.lte(1)),
          }),
        )
        .check(z.length(6)),
    ),
    bidDistribution: z
      .array(
        z.strictObject({
          band: z.enum(bidBands),
          count: z.number().check(z.int(), z.nonnegative()),
          share: z.number().check(z.gte(0), z.lte(1)),
        }),
      )
      .check(z.length(5)),
  })
  .check(
    z.superRefine((value, context) => {
      const bins = value.bidDistribution;
      if (
        new Set(bins.map((bin) => bin.band)).size !== 5 ||
        bins.reduce((sum, bin) => sum + bin.count, 0) !== value.sampleSize ||
        bins.some((bin) => Math.abs(bin.share - bin.count / value.sampleSize) > 0.000001)
      ) {
        context.addIssue({ code: "custom", message: "Répartition incohérente" });
      }
      const detailed = value.detailedBidDistribution;
      if (
        detailed &&
        (new Set(detailed.map((bin) => bin.band)).size !== 6 ||
          detailed.reduce((sum, bin) => sum + bin.count, 0) !== value.sampleSize ||
          detailed.some((bin) => Math.abs(bin.share - bin.count / value.sampleSize) > 0.000001) ||
          bins.some(
            (bin) =>
              bin.count !==
              detailed.reduce(
                (sum, part) =>
                  sum +
                  (part.band === bin.band ||
                  (bin.band === "at_least_2" &&
                    (part.band === "from_2_below_3" || part.band === "at_least_3"))
                    ? part.count
                    : 0),
                0,
              ),
          ))
      ) {
        context.addIssue({
          code: "custom",
          message: "Répartition détaillée incohérente",
        });
      }
      const summary = value.summary;
      if (
        summary &&
        (summary.medianHammerPriceEur < value.hammerPriceMiddle50Eur.p25 - 1 ||
          summary.medianHammerPriceEur > value.hammerPriceMiddle50Eur.p75 + 1 ||
          summary.medianHammerToStartingRatio < value.ratioMiddle50.p25 - 0.0001 ||
          summary.medianHammerToStartingRatio > value.ratioMiddle50.p75 + 0.0001)
      ) {
        context.addIssue({ code: "custom", message: "Médiane hors des quartiles" });
      }
    }),
  );

export type AdjudicationDistribution = z.infer<typeof adjudicationDistributionSchema>;

export const propertyTypeDistributionsSchema = z
  .array(
    z.strictObject({
      propertyType: z.enum([
        "apartment",
        "house",
        "commercial",
        "building",
        "land",
        "parking",
        "mixed",
      ]),
      distribution: adjudicationDistributionSchema,
    }),
  )
  .check(
    z.maxLength(7),
    z.refine(
      (items) => new Set(items.map((item) => item.propertyType)).size === items.length,
      "Types de biens dupliqués",
    ),
  );

export const adjudicationEnrichmentSchema = z
  .strictObject({
    distribution: adjudicationDistributionSchema,
    propertyTypes: propertyTypeDistributionsSchema,
  })
  .check(
    z.refine(
      (value) =>
        value.propertyTypes.reduce((sum, item) => sum + item.distribution.sampleSize, 0) <=
        value.distribution.sampleSize,
      "Les sous-échantillons dépassent le total",
    ),
  );

export const bidBandLabels: Record<(typeof bidBands)[number], string> = {
  below_starting: "Sous la mise à prix",
  at_starting: "À la mise à prix",
  above_1_below_1_5: "Au-dessus de la mise, moins de × 1,5",
  from_1_5_below_2: "De × 1,5 à moins de × 2",
  at_least_2: "Au moins × 2",
};

export const detailedBidBandLabels: Record<(typeof detailedBidBands)[number], string> = {
  ...bidBandLabels,
  from_2_below_3: "De × 2 à moins de × 3",
  at_least_3: "Au moins × 3",
};
