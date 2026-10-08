import {
  ADJUDICATION_PRICE_STATISTICS_WARNING,
  adjudicationPriceStatisticsReliability,
  adjudicationPriceStatisticsResponseSchema,
  type AdjudicationPriceStatisticsResponse,
} from "@/lib/adjudication-price-statistics";
import { bidBands } from "@/lib/adjudication-distributions";
import {
  buildTribunalListingStatistics,
  tribunalListingStatisticsResponseSchema,
  type TribunalListingStatisticsCourt,
  type TribunalListingStatisticsResponse,
  type TribunalListingStatisticsSale,
} from "@/lib/tribunal-listing-statistics";
import type { AuctionSale } from "@/lib/types";

/**
 * All values in this file are deliberately synthetic. They are used by the
 * public announcement example only and never come from a tribunal feed.
 */
export const EXAMPLE_TRIBUNAL_STATISTICS_AS_OF = "2026-10-02T10:00:00.000Z" as const;
export const EXAMPLE_TRIBUNAL_STATISTICS_BUILT_AT = "2026-10-02T10:00:00.000Z" as const;
export const EXAMPLE_TRIBUNAL_STATISTICS_REVIEWED_AT = "2026-10-02T10:00:00.000Z" as const;

export const EXAMPLE_TRIBUNAL_STATISTICS_HISTORY_MONTHS = [3, 12, 24, 36] as const;
export type ExampleTribunalStatisticsHistoryMonths =
  (typeof EXAMPLE_TRIBUNAL_STATISTICS_HISTORY_MONTHS)[number];

export const EXAMPLE_TRIBUNAL_STATISTICS_SOURCE_NAMES = [
  "demo-bulletin-synthetique",
  "demo-avis-juridique",
] as const;

type ExampleCourt = TribunalListingStatisticsCourt & {
  cities: readonly string[];
  priceIndex: number;
  pastSaleDates: readonly string[];
  upcomingSaleDates: readonly string[];
};

const EXAMPLE_COURTS: Record<string, ExampleCourt> = {
  "tj-bordeaux": {
    code: "tj-bordeaux",
    name: "Tribunal judiciaire de Bordeaux",
    judicialRegion: "Cour d’appel de Bordeaux",
    cities: ["Bordeaux", "Mérignac", "Pessac", "Talence", "Bègles"],
    priceIndex: 1,
    pastSaleDates: [
      "2026-08-24",
      "2026-08-28",
      "2026-09-03",
      "2026-09-08",
      "2026-09-12",
      "2026-09-18",
      "2026-09-22",
      "2026-09-27",
      "2026-09-30",
    ],
    upcomingSaleDates: [
      "2026-10-15T09:00:00.000Z",
      "2026-10-15T09:30:00.000Z",
      "2026-10-15T10:00:00.000Z",
      "2026-11-12T09:00:00.000Z",
      "2026-11-12T09:30:00.000Z",
      "2026-11-12T10:00:00.000Z",
      "2026-11-20T09:00:00.000Z",
      "2026-11-20T09:30:00.000Z",
    ],
  },
  "tj-nantes": {
    code: "tj-nantes",
    name: "Tribunal judiciaire de Nantes",
    judicialRegion: "Cour d’appel de Rennes",
    cities: ["Nantes", "Rezé", "Saint-Herblain", "Orvault", "Vertou"],
    priceIndex: 1.08,
    pastSaleDates: [
      "2026-08-25",
      "2026-08-30",
      "2026-09-05",
      "2026-09-10",
      "2026-09-15",
      "2026-09-20",
      "2026-09-24",
      "2026-09-28",
      "2026-10-01",
    ],
    upcomingSaleDates: [
      "2026-10-20T09:00:00.000Z",
      "2026-10-20T09:30:00.000Z",
      "2026-11-05T09:00:00.000Z",
      "2026-11-05T09:30:00.000Z",
      "2026-11-15T09:00:00.000Z",
      "2026-11-15T09:30:00.000Z",
      "2026-11-20T09:00:00.000Z",
      "2026-11-20T09:30:00.000Z",
    ],
  },
  "tj-toulouse": {
    code: "tj-toulouse",
    name: "Tribunal judiciaire de Toulouse",
    judicialRegion: "Cour d’appel de Toulouse",
    cities: ["Toulouse", "Balma", "Blagnac", "Colomiers", "Tournefeuille"],
    priceIndex: 0.94,
    pastSaleDates: [
      "2026-08-23",
      "2026-08-27",
      "2026-09-02",
      "2026-09-07",
      "2026-09-13",
      "2026-09-17",
      "2026-09-21",
      "2026-09-26",
      "2026-09-29",
    ],
    upcomingSaleDates: [
      "2026-10-13T09:00:00.000Z",
      "2026-10-17T09:00:00.000Z",
      "2026-10-21T09:00:00.000Z",
      "2026-10-25T09:00:00.000Z",
      "2026-10-29T09:00:00.000Z",
      "2026-11-05T09:00:00.000Z",
      "2026-11-12T09:00:00.000Z",
      "2026-11-19T09:00:00.000Z",
    ],
  },
};

/**
 * This map is intentionally the only way to opt into the fixture. A real
 * listing with a similar city or court name therefore cannot receive demo
 * statistics accidentally.
 */
export const EXAMPLE_TRIBUNAL_STATISTICS_SALE_IDS: Readonly<Record<string, string>> = {
  "example-immojudis-bordeaux-t2": "tj-bordeaux",
  "example-immojudis-nantes-maison": "tj-nantes",
  "example-immojudis-toulouse-maison": "tj-toulouse",
};

const PROPERTY_TYPES = [
  "appartement",
  "appartement",
  "appartement",
  "appartement",
  "appartement",
  "appartement",
  "appartement",
  "appartement",
  "appartement",
  "appartement",
  "maison",
  "maison",
  "maison",
  "maison",
  "terrain",
  "local commercial",
  "parking",
] as const;

const OCCUPATION_STATUSES = [
  "vacant",
  "vacant",
  "vacant",
  "vacant",
  "vacant",
  "vacant",
  "occupied",
  "occupied",
  "occupied",
  "occupied",
  "occupied",
  "occupied",
  "occupied",
  "occupied",
  "occupied",
  "occupied",
  "rented",
] as const;

const STARTING_PRICES_EUR = [
  12_000, 15_000, 16_000, 17_000, 17_500, 21_000, 18_000, 19_500, 21_000, 14_000, 20_000, 20_000,
  20_500, 22_000, 23_000, 30_000, 32_000,
] as const;

const DVF_ESTIMATES_EUR: Readonly<Record<number, number>> = {
  0: 48_000,
  1: 50_000,
  2: 50_000,
  3: 50_000,
  4: 50_000,
  5: 60_000,
  6: 50_000,
  7: 50_000,
  8: 50_000,
};

const OVERBID_STATUSES = [
  "filed",
  "filed",
  "filed",
  "not_filed",
  "not_filed",
  "not_filed",
  "not_filed",
  "not_filed",
  "not_filed",
  "not_filed",
  "not_filed",
  "not_filed",
  "not_filed",
  "not_filed",
  "not_filed",
  "not_filed",
  "not_filed",
] as const;

type ExampleStatisticsResult = {
  activity: TribunalListingStatisticsResponse;
  prices: AdjudicationPriceStatisticsResponse;
};

/**
 * Returns deterministic, fictional statistics for the three public example
 * announcements. Unknown IDs and non-demo court codes return undefined.
 */
export function getExampleTribunalStatistics(
  sale: AuctionSale,
  historyMonths: ExampleTribunalStatisticsHistoryMonths,
): ExampleStatisticsResult | undefined {
  const expectedCourtCode = EXAMPLE_TRIBUNAL_STATISTICS_SALE_IDS[sale.id];
  if (!expectedCourtCode || sale.tribunal_code !== expectedCourtCode) return undefined;

  const court = EXAMPLE_COURTS[expectedCourtCode];
  if (!court) return undefined;

  const fixtureSales = createFixtureSales(court);
  const activity = buildTribunalListingStatistics({
    court: {
      code: court.code,
      name: court.name,
      judicialRegion: court.judicialRegion,
    },
    sales: fixtureSales,
    asOf: new Date(EXAMPLE_TRIBUNAL_STATISTICS_AS_OF),
    generatedAt: new Date(EXAMPLE_TRIBUNAL_STATISTICS_BUILT_AT),
    historyMonths,
    rawAnnouncements: 20,
    unresolvedStrongAddressDuplicates: 0,
  });
  // The adjudication-price API exposes a reviewed snapshot with its own
  // period. The announcement period selector only filters listing activity.
  const prices = buildExamplePrices(court);

  return {
    activity: tribunalListingStatisticsResponseSchema.parse(activity),
    prices: adjudicationPriceStatisticsResponseSchema.parse(prices),
  };
}

function createFixtureSales(court: ExampleCourt): TribunalListingStatisticsSale[] {
  const saleDates = [
    ...court.pastSaleDates.map((date) => date + "T09:00:00.000Z"),
    ...court.upcomingSaleDates,
  ];

  return saleDates.map((saleDate, index) => {
    const publicationAt = shiftIsoDays(saleDate, -50);
    const hasDvfEstimate = Object.prototype.hasOwnProperty.call(DVF_ESTIMATES_EUR, index);
    const sourceName =
      index % 2 === 0
        ? EXAMPLE_TRIBUNAL_STATISTICS_SOURCE_NAMES[0]
        : EXAMPLE_TRIBUNAL_STATISTICS_SOURCE_NAMES[1];
    const sourceNames =
      index % 3 === 0 ? [sourceName, EXAMPLE_TRIBUNAL_STATISTICS_SOURCE_NAMES[1]] : [sourceName];
    const city = court.cities[index % court.cities.length]!;
    const overbidStatus = OVERBID_STATUSES[index]!;

    return {
      id: "demo-" + court.code + "-announcement-" + String(index + 1).padStart(2, "0"),
      title: "Annonce synthétique " + String(index + 1) + " — " + city,
      city,
      address: String(10 + index) + " rue de la Démonstration, " + city,
      sourceName,
      sourceNames,
      sourceUrls: [
        "https://fixture.immojudis.test/" +
          court.code +
          "/annonce-" +
          String(index + 1).padStart(2, "0"),
      ],
      saleDate,
      status: index < 9 ? "past" : "upcoming",
      startingPriceEur: STARTING_PRICES_EUR[index]!,
      propertyType: PROPERTY_TYPES[index]!,
      visitDates: index === 16 ? [] : [shiftIsoDays(saleDate, -7)],
      occupancyStatus: OCCUPATION_STATUSES[index]!,
      lawyerName: "Me Cabinet Démo " + String((index % 3) + 1),
      publicationAt,
      firstSeenAt: publicationAt,
      overbidStatus,
      overbidEvidence: {
        source: sourceName,
        text:
          overbidStatus === "filed"
            ? "Surenchère déposée — fait explicite de la fixture."
            : "Aucune surenchère déposée dans cette annonce synthétique.",
      },
      marketEstimate: hasDvfEstimate
        ? {
            source: "DVF demo fixture",
            estimatedValueEur: DVF_ESTIMATES_EUR[index]!,
            actionable: true,
            sampleSize: 9,
          }
        : null,
      marketEstimateEligible: hasDvfEstimate,
    };
  });
}

function buildExamplePrices(court: ExampleCourt): AdjudicationPriceStatisticsResponse {
  const periodStart = historyStartFor(3).toISOString().slice(0, 10);
  const periodEnd = EXAMPLE_TRIBUNAL_STATISTICS_AS_OF.slice(0, 10);
  const tribunalSampleSize = 10;
  const nationalSampleSize = 120;

  const national = priceScope({
    scopeType: "national",
    label: "France entière — ventes judiciaires",
    courtCode: null,
    judicialRegion: null,
    periodStart,
    periodEnd,
    sampleSize: nationalSampleSize,
    medianStartingPriceEur: 89_000,
    medianHammerPriceEur: 146_000,
    ratio: 1.64,
    seed: 1,
  });
  const tribunal = priceScope({
    scopeType: "tribunal",
    label: court.name,
    courtCode: court.code,
    judicialRegion: court.judicialRegion,
    periodStart,
    periodEnd,
    sampleSize: tribunalSampleSize,
    medianStartingPriceEur: Math.round(82_000 * court.priceIndex),
    medianHammerPriceEur: Math.round(139_000 * court.priceIndex),
    ratio: round(1.69 + (court.priceIndex - 1) * 0.08, 4),
    seed: 2,
  });

  return {
    national,
    tribunal,
    meta: {
      sourceName: "licitor",
      sourceLabel: "Résultats d’adjudication publiés par Licitor",
      methodologyVersion: "licitor_canonical_price_statistics_v1",
      builtAt: EXAMPLE_TRIBUNAL_STATISTICS_BUILT_AT,
      reviewedAt: EXAMPLE_TRIBUNAL_STATISTICS_REVIEWED_AT,
      experimental: true,
      warning: ADJUDICATION_PRICE_STATISTICS_WARNING,
    },
  };
}

function priceScope(input: {
  scopeType: "national" | "tribunal";
  label: string;
  courtCode: string | null;
  judicialRegion: string | null;
  periodStart: string;
  periodEnd: string;
  sampleSize: number;
  medianStartingPriceEur: number;
  medianHammerPriceEur: number;
  ratio: number;
  seed: number;
}) {
  const distribution = priceDistribution(input.sampleSize, input.seed);
  const belowStartingCount =
    distribution.bidDistribution.find((band) => band.band === "below_starting")?.count ?? 0;
  const atStartingCount =
    distribution.bidDistribution.find((band) => band.band === "at_starting")?.count ?? 0;
  const atLeastDoubleCount =
    distribution.bidDistribution.find((band) => band.band === "at_least_2")?.count ?? 0;
  return {
    scopeType: input.scopeType,
    label: input.label,
    courtCode: input.courtCode,
    judicialRegion: input.judicialRegion,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    sampleSize: input.sampleSize,
    reliability: adjudicationPriceStatisticsReliability(input.sampleSize),
    distribution,
    metrics: {
      medianHammerToStartingRatio: input.ratio,
      aboveStartingRate:
        (input.sampleSize - belowStartingCount - atStartingCount) / input.sampleSize,
      atLeastDoubleRate: atLeastDoubleCount / input.sampleSize,
      medianHammerPriceEur: input.medianHammerPriceEur,
      medianStartingPriceEur: input.medianStartingPriceEur,
    },
  } satisfies AdjudicationPriceStatisticsResponse["national"];
}

function priceDistribution(sampleSize: number, seed: number) {
  const counts = [
    Math.floor(sampleSize * (0.08 + seed * 0.01)),
    Math.floor(sampleSize * (0.18 + seed * 0.01)),
    Math.floor(sampleSize * 0.36),
    Math.floor(sampleSize * (0.23 - seed * 0.01)),
  ];
  counts.push(sampleSize - counts.reduce((total, count) => total + count, 0));

  return {
    sampleSize,
    hammerPriceMiddle50Eur: {
      p25: 72_000 + seed * 2_000,
      p75: 238_000 + seed * 3_000,
    },
    ratioMiddle50: {
      p25: 1.18 + seed * 0.02,
      p75: 2.12 + seed * 0.03,
    },
    bidDistribution: bidBands.map((band, index) => ({
      band,
      count: counts[index]!,
      share: counts[index]! / sampleSize,
    })),
  };
}

function historyStartFor(historyMonths: ExampleTribunalStatisticsHistoryMonths): Date {
  return new Date(Date.UTC(2026, 9 - historyMonths, 2, 10));
}

function shiftIsoDays(value: string, days: number): string {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
