import { describe, expect, it } from "vitest";
import {
  buildTribunalListingStatistics,
  hasVisitDate,
  TRIBUNAL_LISTING_STATISTICS_MIN_SAMPLE,
  TRIBUNAL_LISTING_STATISTICS_MIN_SUBGROUP_SAMPLE,
  tribunalListingStatisticsPeriod,
  tribunalListingStatisticsQuerySchema,
  wilsonInterval,
} from "@/lib/tribunal-listing-statistics";

const AS_OF = new Date("2026-08-20T12:00:00.000Z");
const COURT = {
  code: "justice_tj_1_112",
  name: "TJ Saint-Etienne",
  judicialRegion: "Lyon",
};

/** Les champs `shareLow` et `shareHigh` d'une part de `count` sur `total`. */
function interval(count: number, total: number) {
  const { low, high } = wilsonInterval(count, total)!;
  return { shareLow: low, shareHigh: high };
}

describe("tribunal listing statistics", () => {
  it("uses a calendar sliding window for the recent listing cohort", () => {
    const period = tribunalListingStatisticsPeriod(AS_OF, 3);
    expect(period.historyStart.toISOString()).toBe("2026-05-20T12:00:00.000Z");
    expect(period.historyEnd.toISOString()).toBe(AS_OF.toISOString());
  });

  it("builds the reference contract with explicit date, occupation and DVF denominators", () => {
    const result = buildTribunalListingStatistics({
      court: COURT,
      asOf: AS_OF,
      historyMonths: 3,
      sales: [
        sale("one", "2026-06-01T10:00:00.000Z", "apartment", "vacant", 10_000, "filed"),
        sale("two", "2026-06-02T10:00:00.000Z", "house", "owner_occupied", 20_000, "not_filed"),
        sale("three", "2026-06-03T10:00:00.000Z", "maison", "squatted", 30_000, "filed"),
        sale("four", "2026-06-04T10:00:00.000Z", "other", "rented", 40_000, "not_filed"),
        sale("five", "2026-06-05T10:00:00.000Z", null, null, 50_000, "not_filed"),
        sale("six", "2026-06-06T10:00:00.000Z", "apartment", "unknown", 60_000, "not_filed"),
        {
          ...sale("future", "2026-08-25T10:00:00.000Z", "house", "vacant", 70_000, "filed"),
          status: "upcoming",
          publicationAt: "2026-08-10T10:00:00.000Z",
          visitDates: ["31/02/2026", "2026-08-22T10:00:00.000Z"],
        },
      ],
    });

    expect(result.schemaVersion).toBe("tribunal_listing_statistics_v2");
    expect(result.activity.observedAnnouncements).toBe(7);
    expect(result.activity.publicationDatesKnown).toBe(1);
    expect(result.activity.discoveryDatesUsed).toBe(6);
    expect(result.activity.occupation).toEqual({
      knownSales: 5,
      unknownSales: 2,
      distribution: [
        { status: "vacant", count: 2, share: 0.4, ...interval(2, 5) },
        { status: "occupied", count: 2, share: 0.4, ...interval(2, 5) },
        { status: "rented", count: 1, share: 0.2, ...interval(1, 5) },
      ],
    });
    expect(result.activity.propertyTypes).toEqual([
      { propertyType: "house", count: 3, share: 0.5, ...interval(3, 6) },
      { propertyType: "apartment", count: 2, share: 0.333333, ...interval(2, 6) },
      { propertyType: "other", count: 1, share: 0.166667, ...interval(1, 6) },
    ]);
    expect(result.activity.overbidsKnown).toBe(7);
    // 7 observations : sous le seuil de publication de 10, ni taux ni médiane.
    expect(result.activity.overbidCoverage).toEqual({
      status: "insufficient_data",
      value: null,
      sampleSize: 7,
    });
    // Entre 5 et 9, la fourchette observée seulement : toutes les mises à prix valent la moitié du DVF.
    expect(result.activity.startingPriceToDvfRatio).toEqual({
      status: "range_only",
      value: null,
      min: 0.5,
      max: 0.5,
      sampleSize: 7,
    });
    expect(result.activity.upcomingListings.map((item) => item.id)).toEqual(["future"]);
    expect(result.activity.upcomingListings[0]?.hasVisit).toBe(true);
  });

  it("only recognises an actual visit date and never arbitrary truthy values", () => {
    expect(hasVisitDate([])).toBe(false);
    expect(hasVisitDate(null)).toBe(false);
    expect(hasVisitDate([null, {}, "texte sans date", "31/02/2026"])).toBe(false);
    expect(hasVisitDate(["2026-08-22T10:00:00.000Z"])).toBe(true);
    expect(hasVisitDate(["22 août 2026"])).toBe(true);
  });

  it("does not turn legal surenchère language into an observed event", () => {
    const result = buildTribunalListingStatistics({
      court: COURT,
      asOf: AS_OF,
      historyMonths: 3,
      sales: Array.from({ length: 5 }, (_, index) => ({
        id: `legal-${index}`,
        saleDate: `2026-06-${String(index + 10).padStart(2, "0")}T10:00:00.000Z`,
        status: "past",
        firstSeenAt: "2026-06-01T09:00:00.000Z",
        startingPriceEur: 10_000,
        propertyType: "apartment",
        visitDates: [],
        overbidEvidence: ["La surenchère est possible dans le délai légal."],
      })),
    });
    expect(result.activity.overbidsKnown).toBe(0);
    expect(result.activity.overbidsUnknown).toBe(5);
    expect(result.activity.overbidCoverage).toMatchObject({
      status: "insufficient_data",
      sampleSize: 0,
    });
  });

  it("excludes missing and non-positive starting prices from the price sample", () => {
    const result = buildTribunalListingStatistics({
      court: COURT,
      asOf: AS_OF,
      historyMonths: 3,
      sales: Array.from({ length: 5 }, (_, index) => ({
        ...sale(
          `price-${index}`,
          `2026-06-${String(index + 10).padStart(2, "0")}T10:00:00.000Z`,
          "apartment",
          null,
          index < 4 ? 10_000 : 0,
          null,
        ),
        startingPriceEur: index < 4 ? 10_000 : index === 4 ? 0 : null,
      })),
    });

    expect(result.activity.startingPriceEur).toEqual({
      status: "insufficient_data",
      value: null,
      sampleSize: 4,
    });
  });

  it("écarte les fragments descriptifs de commune et les consignes procédurales d’avocat", () => {
    const result = buildTribunalListingStatistics({
      court: COURT,
      asOf: AS_OF,
      historyMonths: 3,
      sales: [
        {
          ...sale("invalid-label", "2026-08-25T10:00:00.000Z", "apartment", null, 10_000, null),
          status: "upcoming",
          city: "USAGE D'HABITATION à Targon",
          lawyerName:
            "Les enchères ne pourront être portées que par le ministère d'Avocat inscrit au Barreau de Bordeaux",
          publicationAt: "2026-08-01T10:00:00.000Z",
        },
        {
          ...sale("valid-city", "2026-06-10T10:00:00.000Z", "house", null, 20_000, null),
          city: "Bordeaux",
          lawyerName: "Maître Jeanne Dupont",
        },
      ],
    });

    expect(result.activity.communes).toEqual([
      { city: "Bordeaux", count: 1, share: 1, ...interval(1, 1) },
    ]);
    expect(result.activity.lawyers).toEqual([
      { name: "Maître Jeanne Dupont", count: 1, share: 1, ...interval(1, 1) },
    ]);
    expect(result.activity.upcomingListings[0]?.city).toBeNull();
  });

  it("conserve les noms professionnels même lorsqu’ils mentionnent avocat ou barreau", () => {
    const lawyerNames = [
      "Maître Alice Martin, avocat au Barreau de Bordeaux",
      "Me Bruno Leroy · Avocat inscrit au Barreau de Bordeaux",
      "Cabinet Durand, avocat au Barreau de Bordeaux",
      "SCP Petit & Associés · Barreau de Bordeaux",
    ];
    const result = buildTribunalListingStatistics({
      court: COURT,
      asOf: AS_OF,
      historyMonths: 3,
      sales: lawyerNames.map((lawyerName, index) => ({
        ...sale(
          `lawyer-${index}`,
          `2026-06-${String(index + 10).padStart(2, "0")}T10:00:00.000Z`,
          "apartment",
          null,
          10_000 + index,
          null,
        ),
        city: "Bordeaux",
        lawyerName,
      })),
    });

    expect(result.activity.lawyers).toHaveLength(lawyerNames.length);
    expect(result.activity.lawyers.map((lawyer) => lawyer.name)).toEqual(
      expect.arrayContaining(lawyerNames),
    );
  });

  describe("seuils de publication", () => {
    type Override = Record<string, unknown> | null;

    /** `count` annonces passées, avec la mise à prix `10 000 + 1 000 × index`. */
    function cohort(
      count: number,
      options: {
        overbidKnown?: (index: number) => boolean;
        estimate?: (index: number) => Override;
        visit?: (index: number) => boolean;
      } = {},
    ) {
      return Array.from({ length: count }, (_, index) => {
        const startingPriceEur = 10_000 + index * 1_000;
        const base = {
          ...sale(
            `cohort-${index}`,
            `2026-06-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
            "apartment",
            "vacant",
            startingPriceEur,
            options.overbidKnown?.(index) ? "not_filed" : null,
          ),
          visitDates: options.visit?.(index) ? ["2026-05-30T10:00:00.000Z"] : [],
        };
        if (!options.estimate) return base;
        const override = options.estimate(index);
        return {
          ...base,
          marketEstimate: {
            source: "DVF normalisé",
            estimatedValueEur: startingPriceEur * 2,
            actionable: true,
            ...PASSING_ESTIMATE_QUALITY,
            ...override,
          },
        };
      });
    }

    function build(sales: ReturnType<typeof cohort>) {
      return buildTribunalListingStatistics({
        court: COURT,
        asOf: AS_OF,
        historyMonths: 3,
        sales,
      });
    }

    it("publishes from 10 observations, as the response says", () => {
      const result = build(cohort(10));
      expect(TRIBUNAL_LISTING_STATISTICS_MIN_SAMPLE).toBe(10);
      expect(TRIBUNAL_LISTING_STATISTICS_MIN_SUBGROUP_SAMPLE).toBe(20);
      expect(result.meta).toMatchObject({
        minSampleSize: 10,
        minSubgroupSampleSize: 20,
        minRangeSampleSize: 5,
        minOverbidCoverage: 0.5,
      });
      expect(result.activity.startingPriceEur).toEqual({
        status: "published",
        value: 14_500,
        sampleSize: 10,
        interval: null,
      });
    });

    it("shows only the observed range, never a point, from 5 to 9 observations", () => {
      for (const count of [5, 9]) {
        const metric = build(cohort(count)).activity.startingPriceEur;
        expect(metric).toEqual({
          status: "range_only",
          value: null,
          min: 10_000,
          max: 10_000 + (count - 1) * 1_000,
          sampleSize: count,
        });
      }
    });

    it("shows nothing under 5 observations", () => {
      expect(build(cohort(4)).activity.startingPriceEur).toEqual({
        status: "insufficient_data",
        value: null,
        sampleSize: 4,
      });
    });

    it("publishes a share with its Wilson interval, and nothing under 10 observations", () => {
      const published = build(cohort(12, { visit: (index) => index < 9 })).activity.visitCoverage;
      expect(published).toEqual({
        status: "published",
        value: 0.75,
        sampleSize: 12,
        interval: wilsonInterval(9, 12),
      });
      expect(build(cohort(9, { visit: () => true })).activity.visitCoverage).toEqual({
        status: "insufficient_data",
        value: null,
        sampleSize: 9,
      });
    });

    it("publishes the overbid rate only when at least half of the announcements have an answer", () => {
      // 10 réponses connues sur 20 annonces : la moitié, publié.
      const half = build(cohort(20, { overbidKnown: (index) => index < 10 }));
      expect(half.activity.overbidCoverage).toMatchObject({ status: "published", sampleSize: 10 });
      // 10 réponses connues sur 21 annonces : moins de la moitié, masqué.
      const under = build(cohort(21, { overbidKnown: (index) => index < 10 }));
      expect(under.activity.overbidsKnown).toBe(10);
      expect(under.activity.overbidCoverage).toEqual({
        status: "insufficient_data",
        value: null,
        sampleSize: 10,
      });
    });

    it("keeps the DVF ratio to the estimates that pass the gate of the public band", () => {
      const ratio = (estimate: (index: number) => Override) =>
        build(cohort(10, { estimate })).activity.startingPriceToDvfRatio;
      expect(ratio(() => ({}))).toMatchObject({ status: "published", sampleSize: 10 });
      // Chacune de ces estimations est refusée par la bande publique : hors de la statistique.
      const refused: Record<string, Record<string, unknown>> = {
        "peu de ventes comparables, sans jackknife": {
          sampleSize: 7,
          intervalMethod: "segment_fallback",
        },
        "5 ventes comparables avec jackknife": { sampleSize: 5 },
        "échantillon effectif de 4": { effectiveSampleSize: 4 },
        "fourchette de 70 % de la valeur": { pricePerM2P10: 2_300, pricePerM2P90: 4_400 },
        "rayon de 1 500 m pour un appartement urbain": { radiusM: 1_500 },
        "rayon inconnu": { radiusM: null },
        "champs de qualité absents": {
          effectiveSampleSize: null,
          intervalMethod: null,
          pricePerM2P10: null,
          pricePerM2P50: null,
          pricePerM2P90: null,
          radiusM: null,
        },
      };
      for (const [name, override] of Object.entries(refused)) {
        const metric = ratio((index) => (index === 0 ? override : {}));
        expect(metric, name).toMatchObject({ status: "range_only", sampleSize: 9 });
      }
      // Une maison accepte 2 000 m, un appartement urbain non.
      expect(
        ratio((index) => (index === 0 ? { segment: "house", radiusM: 2_000 } : {})),
      ).toMatchObject({ status: "published", sampleSize: 10 });
    });

    it("computes the Wilson interval at 95 %", () => {
      expect(wilsonInterval(5, 10)).toEqual({ low: 0.236593, high: 0.763407 });
      expect(wilsonInterval(0, 10)).toEqual({ low: 0, high: 0.277533 });
      expect(wilsonInterval(10, 10)).toEqual({ low: 0.722467, high: 1 });
      expect(wilsonInterval(1, 1)).toEqual({ low: 0.206549, high: 1 });
      expect(wilsonInterval(0, 0)).toBeNull();
      expect(wilsonInterval(3, 2)).toBeNull();
      expect(wilsonInterval(-1, 5)).toBeNull();
      expect(wilsonInterval(1.5, 5)).toBeNull();
    });
  });

  it("keeps the query default at three months while accepting the supported windows", () => {
    expect(tribunalListingStatisticsQuerySchema.parse({ courtCode: " Justice_TJ_1_112 " })).toEqual(
      {
        courtCode: "justice_tj_1_112",
        historyMonths: 3,
      },
    );
    expect(
      tribunalListingStatisticsQuerySchema.parse({
        saleId: "11111111-1111-4111-8111-111111111111",
        historyMonths: "36",
      }),
    ).toEqual({ saleId: "11111111-1111-4111-8111-111111111111", historyMonths: 36 });
  });
});

function sale(
  id: string,
  saleDate: string,
  propertyType: string | null,
  occupancyStatus: string | null,
  startingPriceEur: number,
  overbidStatus: string | null,
) {
  return {
    id,
    saleDate,
    status: "past",
    firstSeenAt: "2026-06-01T09:00:00.000Z",
    startingPriceEur,
    propertyType,
    occupancyStatus,
    visitDates: ["texte sans date"],
    overbidStatus,
    marketEstimate: {
      source: "DVF normalisé",
      estimatedValueEur: startingPriceEur * 2,
      actionable: true,
      ...PASSING_ESTIMATE_QUALITY,
    },
    marketEstimateEligible: true,
  };
}

/** Une estimation qui passe la porte de la bande publique (market-gap-band.ts). */
const PASSING_ESTIMATE_QUALITY = {
  sampleSize: 12,
  effectiveSampleSize: 8,
  intervalMethod: "local_jackknife",
  pricePerM2P10: 2_400,
  pricePerM2P50: 3_000,
  pricePerM2P90: 3_600,
  radiusM: 500,
  segment: "apartment",
  areaKind: "urban",
};
