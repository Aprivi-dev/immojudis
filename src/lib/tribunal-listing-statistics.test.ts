import { describe, expect, it } from "vitest";
import {
  buildTribunalListingStatistics,
  hasVisitDate,
  tribunalListingStatisticsPeriod,
  tribunalListingStatisticsQuerySchema,
} from "@/lib/tribunal-listing-statistics";

const AS_OF = new Date("2026-08-20T12:00:00.000Z");
const COURT = {
  code: "justice_tj_1_112",
  name: "TJ Saint-Etienne",
  judicialRegion: "Lyon",
};

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

    expect(result.schemaVersion).toBe("tribunal_listing_statistics_v1");
    expect(result.activity.observedAnnouncements).toBe(7);
    expect(result.activity.publicationDatesKnown).toBe(1);
    expect(result.activity.discoveryDatesUsed).toBe(6);
    expect(result.activity.occupation).toEqual({
      knownSales: 5,
      unknownSales: 2,
      distribution: [
        { status: "vacant", count: 2, share: 0.4 },
        { status: "occupied", count: 2, share: 0.4 },
        { status: "rented", count: 1, share: 0.2 },
      ],
    });
    expect(result.activity.propertyTypes).toEqual([
      { propertyType: "house", count: 3, share: 0.5 },
      { propertyType: "apartment", count: 2, share: 0.333333 },
      { propertyType: "other", count: 1, share: 0.166667 },
    ]);
    expect(result.activity.overbidsKnown).toBe(7);
    expect(result.activity.overbidCoverage).toMatchObject({ status: "published", sampleSize: 7 });
    expect(result.activity.startingPriceToDvfRatio).toMatchObject({
      status: "published",
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

    expect(result.activity.communes).toEqual([{ city: "Bordeaux", count: 1, share: 1 }]);
    expect(result.activity.lawyers).toEqual([{ name: "Maître Jeanne Dupont", count: 1, share: 1 }]);
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
      sampleSize: 12,
    },
    marketEstimateEligible: true,
  };
}
