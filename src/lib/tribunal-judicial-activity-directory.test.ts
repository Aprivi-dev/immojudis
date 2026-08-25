import { describe, expect, it } from "vitest";
import {
  buildTribunalJudicialActivityDirectory,
  tribunalJudicialActivityDirectoryQuerySchema,
  type TribunalJudicialActivityDirectorySale,
} from "@/lib/tribunal-judicial-activity-directory";

const AS_OF = new Date("2026-08-20T12:00:00.000Z");

describe("tribunal judicial activity directory", () => {
  it("publie uniquement les tribunaux actifs exactement rattachés et totalise leurs annonces", () => {
    const result = buildTribunalJudicialActivityDirectory({
      courts: [
        { code: "marseille", name: "TJ Marseille", judicialRegion: "Aix" },
        { code: "paris", name: "TJ Paris", judicialRegion: "Paris" },
      ],
      sales: [
        activitySale("marseille", "one", 20),
        activitySale("marseille", "two", 25),
        activitySale("paris", "three", 30),
        activitySale("tribunal-inconnu", "ignored", 35),
      ],
      asOf: AS_OF,
      historyMonths: 36,
    });

    expect(result.totals).toEqual({
      trackedCourts: 2,
      observedPastSales: 0,
      upcomingSales: 3,
      upcomingSales90Days: 3,
    });
    expect(result.national).toMatchObject({
      observedPastSales: 0,
      upcomingSales: 3,
      coverage: {
        trackedCourts: 2,
        publishableCourtProfiles: 0,
        rate: 0,
      },
    });
    expect(result.regions.map((region) => region.name)).toEqual(["Aix", "Paris"]);
    expect(result.regions.reduce((total, region) => total + region.upcomingSales, 0)).toBe(3);
    expect(result.tribunals.map((tribunal) => tribunal.court.code)).toEqual(["marseille", "paris"]);
    expect(result.provenance.includesOnlyExactActiveCourts).toBe(true);
    expect(result.provenance.aggregationOrder).toBe("national_region_tribunal");
  });

  it("publie les repères nationaux et régionaux sans moyenner les médianes tribunal", () => {
    const result = buildTribunalJudicialActivityDirectory({
      courts: [
        { code: "marseille", name: "TJ Marseille", judicialRegion: "Aix" },
        { code: "paris", name: "TJ Paris", judicialRegion: "Paris" },
      ],
      sales: [
        ...Array.from({ length: 5 }, (_, index) =>
          activitySale("marseille", `marseille-${index}`, 10 + index, 40_000 + index * 10_000),
        ),
        ...Array.from({ length: 5 }, (_, index) =>
          activitySale("paris", `paris-${index}`, 20 + index, 200_000 + index * 10_000),
        ),
      ],
      asOf: AS_OF,
      historyMonths: 36,
    });

    expect(result.national.startingPriceRangeEur).toMatchObject({
      status: "published",
      p50: 140_000,
      sampleSize: 10,
    });
    expect(result.national.coverage).toEqual({
      trackedCourts: 2,
      publishableCourtProfiles: 2,
      rate: 1,
    });
    expect(
      result.regions.find((region) => region.name === "Aix")?.startingPriceRangeEur,
    ).toMatchObject({
      status: "published",
      p50: 60_000,
      sampleSize: 5,
    });
  });

  it("normalise la fenêtre et refuse tout paramètre inattendu", () => {
    expect(tribunalJudicialActivityDirectoryQuerySchema.parse({ historyMonths: "12" })).toEqual({
      historyMonths: 12,
    });
    expect(() =>
      tribunalJudicialActivityDirectoryQuerySchema.parse({ historyMonths: 36, courtCode: "paris" }),
    ).toThrow();
  });
});

function activitySale(
  tribunalCode: string,
  id: string,
  daysFromNow: number,
  startingPriceEur = 50_000,
): TribunalJudicialActivityDirectorySale {
  const saleDate = new Date(AS_OF.getTime() + daysFromNow * 24 * 60 * 60 * 1_000);
  return {
    tribunalCode,
    id,
    saleDate: saleDate.toISOString(),
    status: "upcoming",
    startingPriceEur,
    propertyType: "apartment",
    visitDates: [],
    firstSeenAt: new Date(saleDate.getTime() - 30 * 24 * 60 * 60 * 1_000).toISOString(),
  };
}
