import { describe, expect, it } from "vitest";
import { adjudicationPriceStatisticsResponseSchema } from "@/lib/adjudication-price-statistics";
import { EXAMPLE_SALE_RECORDS } from "@/lib/example-sale";
import {
  EXAMPLE_TRIBUNAL_STATISTICS_HISTORY_MONTHS,
  getExampleTribunalStatistics,
} from "@/lib/example-tribunal-statistics";
import { tribunalListingStatisticsResponseSchema } from "@/lib/tribunal-listing-statistics";

describe("example tribunal listing statistics", () => {
  it("publie la cohorte fictive attendue et ses seuils de qualité", () => {
    const result = getExampleTribunalStatistics(EXAMPLE_SALE_RECORDS.bordeaux.sale, 3);

    expect(result).toBeDefined();
    expect(() => tribunalListingStatisticsResponseSchema.parse(result?.activity)).not.toThrow();
    expect(() => adjudicationPriceStatisticsResponseSchema.parse(result?.prices)).not.toThrow();

    const activity = result!.activity.activity;
    expect(activity.observedAnnouncements).toBe(17);
    expect(activity.upcomingSales).toBe(8);
    expect(activity.startingPriceEur).toEqual({
      status: "published",
      value: 20_000,
      sampleSize: 17,
    });
    expect(activity.startingPriceToDvfRatio).toEqual({
      status: "published",
      value: 0.35,
      sampleSize: 9,
    });
    expect(activity.propertyTypes).toEqual([
      { propertyType: "apartment", count: 10, share: 0.588235 },
      { propertyType: "house", count: 4, share: 0.235294 },
      { propertyType: "other", count: 3, share: 0.176471 },
    ]);
    expect(activity.occupation).toEqual({
      knownSales: 17,
      unknownSales: 0,
      distribution: [
        { status: "vacant", count: 6, share: 0.352941 },
        { status: "occupied", count: 10, share: 0.588235 },
        { status: "rented", count: 1, share: 0.058824 },
      ],
    });
    expect(activity.visitCoverage).toEqual({
      status: "published",
      value: 0.9412,
      sampleSize: 17,
    });
    expect(activity.overbidCoverage).toEqual({
      status: "published",
      value: 0.1765,
      sampleSize: 17,
    });
    expect(activity.overbidsKnown).toBe(17);
    expect(activity.overbidsUnknown).toBe(0);
    expect(activity.publishedToHearingDays).toEqual({
      status: "published",
      value: 50,
      sampleSize: 17,
    });
    expect(result!.activity.meta).toMatchObject({
      rawAnnouncements: 20,
      deduplicatedAnnouncements: 17,
      unresolvedStrongAddressDuplicates: 0,
      minSampleSize: 5,
      publicationDateBasis: "source_publication_date_or_first_seen_at",
    });
    expect(result!.prices.tribunal?.sampleSize).toBe(10);
  });

  it("sélectionne strictement le tribunal et varie son calendrier", () => {
    const bordeaux = getExampleTribunalStatistics(EXAMPLE_SALE_RECORDS.bordeaux.sale, 12);
    const nantes = getExampleTribunalStatistics(EXAMPLE_SALE_RECORDS.nantes.sale, 12);
    const toulouse = getExampleTribunalStatistics(EXAMPLE_SALE_RECORDS.toulouse.sale, 12);

    expect(bordeaux?.activity.court).toMatchObject({ code: "tj-bordeaux" });
    expect(nantes?.activity.court).toMatchObject({ code: "tj-nantes" });
    expect(toulouse?.activity.court).toMatchObject({ code: "tj-toulouse" });
    expect(bordeaux?.activity.court.name).not.toContain("Saint-Étienne");
    expect(nantes?.activity.court.name).not.toContain("Saint-Étienne");
    expect(toulouse?.activity.court.name).not.toContain("Saint-Étienne");

    expect(bordeaux!.activity.activity.hearingCalendar).toHaveLength(3);
    expect(nantes!.activity.activity.hearingCalendar).toHaveLength(4);
    expect(toulouse!.activity.activity.hearingCalendar).toHaveLength(8);
    expect(bordeaux!.prices.tribunal?.courtCode).toBe("tj-bordeaux");
    expect(nantes!.prices.tribunal?.courtCode).toBe("tj-nantes");
    expect(toulouse!.prices.tribunal?.courtCode).toBe("tj-toulouse");
  });

  it("fait varier l’activité sans simuler un filtre sur le snapshot de prix", () => {
    const results = EXAMPLE_TRIBUNAL_STATISTICS_HISTORY_MONTHS.map((historyMonths) =>
      getExampleTribunalStatistics(EXAMPLE_SALE_RECORDS.bordeaux.sale, historyMonths),
    );

    expect(results.every(Boolean)).toBe(true);
    expect(results.map((result) => result!.activity.period.historyMonths)).toEqual([3, 12, 24, 36]);
    expect(new Set(results.map((result) => result!.activity.period.historyStart)).size).toBe(4);
    expect(new Set(results.map((result) => result!.prices.tribunal?.periodStart)).size).toBe(1);
    expect(new Set(results.map((result) => result!.prices.tribunal?.periodEnd)).size).toBe(1);
    expect(results.map((result) => result!.prices.tribunal?.sampleSize)).toEqual([10, 10, 10, 10]);
    expect(results.map((result) => result!.prices.national.sampleSize)).toEqual([
      120, 120, 120, 120,
    ]);
    expect(results[1]!.prices).toEqual(results[0]!.prices);
    expect(results[2]!.prices).toEqual(results[0]!.prices);
    expect(results[3]!.prices).toEqual(results[0]!.prices);
  });

  it("ne fabrique aucune fixture pour une annonce ou un code inconnus", () => {
    const bordeaux = EXAMPLE_SALE_RECORDS.bordeaux.sale;

    expect(
      getExampleTribunalStatistics({ ...bordeaux, id: "sale-reelle-sans-fixture" }, 3),
    ).toBeUndefined();
    expect(
      getExampleTribunalStatistics({ ...bordeaux, tribunal_code: "tj-saint-etienne" }, 3),
    ).toBeUndefined();
    expect(getExampleTribunalStatistics({ ...bordeaux, tribunal_code: null }, 3)).toBeUndefined();
    expect(
      getExampleTribunalStatistics({ ...bordeaux, id: "example-immojudis-nantes-maison" }, 3),
    ).toBeUndefined();
  });

  it("expose la provenance fictive et des annonces à venir dédupliquées", () => {
    const result = getExampleTribunalStatistics(EXAMPLE_SALE_RECORDS.bordeaux.sale, 3)!;
    const upcomingIds = result.activity.activity.upcomingListings.map((listing) => listing.id);

    expect(result.activity.meta.sources).toEqual(
      expect.arrayContaining(["demo-avis-juridique", "demo-bulletin-synthetique"]),
    );
    expect(result.activity.meta.sources.every((source) => source.startsWith("demo-"))).toBe(true);
    expect(upcomingIds).toHaveLength(8);
    expect(new Set(upcomingIds).size).toBe(8);
    expect(upcomingIds.every((id) => id.startsWith("demo-tj-bordeaux-"))).toBe(true);
    expect(result.activity.meta.deduplication).toBe("canonical_id_source_url_strong_address");
  });
});
