import { describe, expect, it } from "vitest";
import {
  buildTribunalJudicialActivity,
  judicialActivityPeriod,
  tribunalJudicialActivityQuerySchema,
  type TribunalJudicialActivitySale,
} from "@/lib/tribunal-judicial-activity";

const AS_OF = new Date("2026-08-20T12:00:00.000Z");
const COURT = {
  code: "justice_tj_1_59",
  name: "TJ Marseille",
  judicialRegion: "Aix-en-Provence",
};

describe("tribunal judicial activity", () => {
  it("publie l’activité judiciaire utile avec ses échantillons", () => {
    const sales = [
      sale("one", "2026-08-30T09:00:00.000Z", 20_000, "apartment", true, 10),
      sale("two", "2026-09-09T09:00:00.000Z", 30_000, "apartment", true, 20),
      sale("three", "2026-09-19T09:00:00.000Z", 40_000, "house", true, 30),
      sale("four", "2026-09-29T09:00:00.000Z", 50_000, "house", true, 40),
      sale("five", "2026-11-28T09:00:00.000Z", 60_000, "house", false, 50),
      {
        ...sale("past", "2026-05-10T09:00:00.000Z", 70_000, "land", true, 20),
        status: "adjudicated",
      },
      {
        ...sale("stale", "2026-08-10T09:00:00.000Z", 99_000, "other", true, 10),
        status: "upcoming",
      },
      sale("too-far", "2028-01-10T09:00:00.000Z", 150_000, "other", true, 10),
    ];

    const result = buildTribunalJudicialActivity({
      court: COURT,
      sales,
      asOf: AS_OF,
      historyMonths: 36,
    });

    expect(result.activity).toMatchObject({
      observedPastSales: 1,
      upcomingSales: 5,
      upcomingSales90Days: 4,
      upcomingHearingDays: 5,
      nextSaleAt: "2026-08-30T09:00:00.000Z",
      medianStartingPriceEur: { status: "published", value: 45_000, sampleSize: 6 },
      startingPriceRangeEur: {
        status: "published",
        p25: 32_500,
        p50: 45_000,
        p75: 57_500,
        sampleSize: 6,
      },
      visitCoverage: { status: "published", value: 0.8, sampleSize: 5 },
      medianDiscoveryLeadDays: { status: "published", value: 25, sampleSize: 6 },
      discoveryLeadRangeDays: {
        status: "published",
        p25: 20,
        p50: 25,
        p75: 37.5,
        sampleSize: 6,
      },
      medianLotsPerHearingDay: { status: "published", value: 1, sampleSize: 5 },
      medianDaysBetweenHearingDays: { status: "published", value: 10, sampleSize: 4 },
    });
    expect(result.activity.topPropertyTypes).toEqual([
      { propertyType: "house", count: 3, share: 0.5 },
      { propertyType: "apartment", count: 2, share: 0.333333 },
      { propertyType: "land", count: 1, share: 0.166667 },
    ]);
    expect(result.reliability).toMatchObject({
      level: "indicative",
      currentSampleSize: 6,
      exactCourtMatch: true,
    });
    expect(result.period.historyStart).toBe("2023-08-01T00:00:00.000Z");
  });

  it("masque les médianes sous cinq annonces tout en conservant le volume observé", () => {
    const result = buildTribunalJudicialActivity({
      court: COURT,
      sales: [
        sale("one", "2026-09-01T09:00:00.000Z", 20_000, "apartment", true, 15),
        sale("two", "2026-09-08T09:00:00.000Z", 40_000, "house", false, 30),
      ],
      asOf: AS_OF,
      historyMonths: 12,
    });

    expect(result.activity.upcomingSales).toBe(2);
    expect(result.activity.medianStartingPriceEur).toEqual({
      status: "insufficient_data",
      value: null,
      sampleSize: 2,
    });
    expect(result.activity.visitCoverage).toEqual({
      status: "insufficient_data",
      value: null,
      sampleSize: 2,
    });
    expect(result.activity.topPropertyTypes).toEqual([]);
    expect(result.activity.startingPriceRangeEur).toEqual({
      status: "insufficient_data",
      p25: null,
      p50: null,
      p75: null,
      sampleSize: 2,
    });
    expect(result.reliability.level).toBe("insufficient_data");
  });

  it("calcule aussi les repères par type de bien quand l’échantillon le permet", () => {
    const result = buildTribunalJudicialActivity({
      court: COURT,
      sales: [
        sale("one", "2026-09-01T09:00:00.000Z", 10_000, "apartment", true, 10),
        sale("two", "2026-09-08T09:00:00.000Z", 20_000, "apartment", true, 20),
        sale("three", "2026-09-15T09:00:00.000Z", 30_000, "apartment", true, 30),
        sale("four", "2026-09-22T09:00:00.000Z", 40_000, "apartment", true, 40),
        sale("five", "2026-09-29T09:00:00.000Z", 50_000, "apartment", true, 50),
      ],
      asOf: AS_OF,
      historyMonths: 36,
    });

    expect(result.activity.propertyTypeBenchmarks).toEqual([
      {
        propertyType: "apartment",
        observedSales: 5,
        startingPriceRangeEur: {
          status: "published",
          p25: 20_000,
          p50: 30_000,
          p75: 40_000,
          sampleSize: 5,
        },
        discoveryLeadRangeDays: {
          status: "published",
          p25: 20,
          p50: 30,
          p75: 40,
          sampleSize: 5,
        },
      },
    ]);
  });

  it("refuse les doublons pour ne jamais compter deux fois une vente", () => {
    const duplicate = sale("duplicate", "2026-09-01T09:00:00.000Z", 50_000, "apartment", true, 20);
    expect(() =>
      buildTribunalJudicialActivity({
        court: COURT,
        sales: [duplicate, duplicate],
        asOf: AS_OF,
        historyMonths: 36,
      }),
    ).toThrow("Duplicate sale");
  });

  it("normalise strictement le code tribunal et les fenêtres autorisées", () => {
    expect(
      tribunalJudicialActivityQuerySchema.parse({
        courtCode: " Justice_TJ_1_59 ",
        historyMonths: "24",
      }),
    ).toEqual({ courtCode: "justice_tj_1_59", historyMonths: 24 });
    expect(() =>
      tribunalJudicialActivityQuerySchema.parse({ courtCode: "marseille,paris" }),
    ).toThrow();
    expect(() =>
      tribunalJudicialActivityQuerySchema.parse({ courtCode: "marseille", historyMonths: 18 }),
    ).toThrow();
    expect(() => tribunalJudicialActivityQuerySchema.parse({})).toThrow();
    expect(() =>
      tribunalJudicialActivityQuerySchema.parse({
        courtCode: "marseille",
        saleId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toThrow();
  });

  it("calcule une période historique au début du mois sans dérive calendaire", () => {
    const period = judicialActivityPeriod(new Date("2026-03-31T23:00:00.000Z"), 12);
    expect(period.historyStart.toISOString()).toBe("2025-03-01T00:00:00.000Z");
    expect(period.upcomingEnd.toISOString()).toBe("2027-03-31T23:00:00.000Z");
  });
});

function sale(
  id: string,
  saleDate: string,
  startingPriceEur: number,
  propertyType: string,
  hasVisit: boolean,
  leadDays: number,
): TribunalJudicialActivitySale {
  const date = new Date(saleDate);
  return {
    id,
    saleDate,
    status: "upcoming",
    startingPriceEur,
    propertyType,
    visitDates: hasVisit ? ["2026-08-25T09:00:00.000Z"] : [],
    firstSeenAt: new Date(date.getTime() - leadDays * 24 * 60 * 60 * 1_000).toISOString(),
  };
}
