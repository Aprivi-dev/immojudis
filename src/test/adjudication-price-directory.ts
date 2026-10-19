import type { AdjudicationDistribution } from "@/lib/adjudication-distributions";
import {
  ADJUDICATION_PRICE_STATISTICS_WARNING,
  adjudicationPriceStatisticsDirectoryResponseSchema,
  type AdjudicationPriceStatisticsDirectoryResponse,
  type AdjudicationPriceStatisticsScope,
} from "@/lib/adjudication-price-statistics";

type Counts = [below: number, at: number, upTo15: number, upTo2: number, twoOrMore: number];

/** Distribution cohérente avec le schéma publié (effectif = somme des cinq tranches). */
export function distributionOf(counts: Counts): AdjudicationDistribution {
  const bands = [
    "below_starting",
    "at_starting",
    "above_1_below_1_5",
    "from_1_5_below_2",
    "at_least_2",
  ] as const;
  const sampleSize = counts.reduce((sum, count) => sum + count, 0);
  return {
    sampleSize,
    hammerPriceMiddle50Eur: { p25: 90_000, p75: 210_000 },
    ratioMiddle50: { p25: 1, p75: 1.8 },
    summary: {
      medianHammerPriceEur: 150_000,
      medianStartingPriceEur: 100_000,
      medianHammerToStartingRatio: 1.3,
      meanHammerToStartingRatio: 1.4,
    },
    bidDistribution: bands.map((band, index) => ({
      band,
      count: counts[index],
      share: counts[index] / sampleSize,
    })),
  };
}

function rates(distribution: AdjudicationDistribution) {
  const count = (band: string) =>
    distribution.bidDistribution.find((item) => item.band === band)?.count ?? 0;
  return {
    above:
      (distribution.sampleSize - count("below_starting") - count("at_starting")) /
      distribution.sampleSize,
    double: count("at_least_2") / distribution.sampleSize,
  };
}

/** Une étiquette de tribunal volontairement reconnaissable, pour prouver qu'elle ne sort pas. */
export const TRIBUNAL_MARKERS = ["TJ Tribunal-Marqueur-A", "TJ Tribunal-Marqueur-B"] as const;
export const COURT_CODE_MARKERS = ["code-marqueur-a", "code-marqueur-b"] as const;

function tribunalScope(
  label: string,
  courtCode: string,
  sampleSize: number,
): AdjudicationPriceStatisticsScope {
  return {
    scopeType: "tribunal",
    label,
    courtCode,
    judicialRegion: "Région-Marqueur",
    periodStart: "2023-10-01",
    periodEnd: "2026-09-30",
    sampleSize,
    reliability: sampleSize >= 30 ? "descriptive" : "limited",
    metrics: {
      medianHammerToStartingRatio: 1.9,
      aboveStartingRate: 0.9,
      atLeastDoubleRate: 0.4,
      medianHammerPriceEur: 777_777,
      medianStartingPriceEur: 333_333,
    },
  };
}

/** Réponse « annuaire » valide : national de 200 prix, trois types de biens, deux tribunaux. */
export function adjudicationDirectoryFixture(): AdjudicationPriceStatisticsDirectoryResponse {
  const national = distributionOf([40, 20, 60, 40, 40]);
  const apartment = distributionOf([20, 10, 25, 15, 10]);
  const house = distributionOf([10, 5, 20, 10, 15]);
  const parking = distributionOf([2, 2, 3, 1, 2]);
  const nationalRates = rates(national);
  return adjudicationPriceStatisticsDirectoryResponseSchema.parse({
    national: {
      scopeType: "national",
      label: "France",
      courtCode: null,
      judicialRegion: null,
      periodStart: "2023-10-01",
      periodEnd: "2026-09-30",
      sampleSize: national.sampleSize,
      reliability: "extended",
      distribution: national,
      propertyTypes: [
        { propertyType: "house", distribution: house },
        { propertyType: "apartment", distribution: apartment },
        { propertyType: "parking", distribution: parking },
      ],
      metrics: {
        medianHammerToStartingRatio: 1.3,
        aboveStartingRate: nationalRates.above,
        atLeastDoubleRate: nationalRates.double,
        medianHammerPriceEur: 150_000,
        medianStartingPriceEur: 100_000,
      },
    },
    tribunals: [
      tribunalScope(TRIBUNAL_MARKERS[0], COURT_CODE_MARKERS[0], 50),
      tribunalScope(TRIBUNAL_MARKERS[1], COURT_CODE_MARKERS[1], 12),
    ],
    meta: {
      sourceName: "licitor",
      sourceLabel: "Résultats d’adjudication publiés par Licitor",
      methodologyVersion: "licitor_canonical_price_statistics_v1",
      builtAt: "2026-10-05T08:00:00.000Z",
      reviewedAt: "2026-10-07T09:30:00.000Z",
      experimental: true,
      warning: ADJUDICATION_PRICE_STATISTICS_WARNING,
    },
  });
}
