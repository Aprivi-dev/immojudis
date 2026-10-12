import { describe, expect, it } from "vitest";
import {
  ADJUDICATION_PRICE_STATISTICS_WARNING,
  adjudicationPriceStatisticsReliability,
  adjudicationPriceStatisticsResponseSchema,
  adjudicationPriceStatisticsDirectoryResponseSchema,
} from "@/lib/adjudication-price-statistics";

describe("adjudication price statistics contract", () => {
  it("refuse de comparer des périodes différentes ou de compter deux fois le même corpus", () => {
    const { national, meta } = responseFixture();
    const tribunal = scopeFixture({ scopeType: "tribunal", courtCode: "paris", sampleSize: 40 });
    expect(
      adjudicationPriceStatisticsDirectoryResponseSchema.safeParse({
        national,
        meta,
        tribunals: [tribunal],
      }).success,
    ).toBe(true);
    expect(
      adjudicationPriceStatisticsDirectoryResponseSchema.safeParse({
        national,
        meta,
        tribunals: [{ ...tribunal, periodEnd: "2026-08-01" }],
      }).success,
    ).toBe(false);
    expect(
      adjudicationPriceStatisticsDirectoryResponseSchema.safeParse({
        national,
        meta,
        tribunals: [{ ...tribunal, sampleSize: 4000 }],
      }).success,
    ).toBe(false);
  });
  it("refuse des dates inexistantes et une part du double supérieure au dépassement simple", () => {
    expect(
      adjudicationPriceStatisticsResponseSchema.safeParse(
        responseFixture({ national: scopeFixture({ periodStart: "2026-02-30" }) }),
      ).success,
    ).toBe(false);
    expect(
      adjudicationPriceStatisticsResponseSchema.safeParse(
        responseFixture({
          national: scopeFixture({
            metrics: { ...scopeFixture().metrics, aboveStartingRate: 0.2, atLeastDoubleRate: 0.5 },
          }),
        }),
      ).success,
    ).toBe(false);
  });
  it("classe explicitement la fiabilité selon la taille de l’échantillon", () => {
    expect(adjudicationPriceStatisticsReliability(10)).toBe("limited");
    expect(adjudicationPriceStatisticsReliability(29)).toBe("limited");
    expect(adjudicationPriceStatisticsReliability(30)).toBe("descriptive");
    expect(adjudicationPriceStatisticsReliability(99)).toBe("descriptive");
    expect(adjudicationPriceStatisticsReliability(100)).toBe("extended");
  });

  it("refuse de publier un échantillon inférieur au seuil", () => {
    expect(() =>
      adjudicationPriceStatisticsResponseSchema.parse(
        responseFixture({ national: scopeFixture({ sampleSize: 9 }) }),
      ),
    ).toThrow();
  });

  it("refuse tout champ brut inattendu dans le contrat premium", () => {
    expect(() =>
      adjudicationPriceStatisticsResponseSchema.parse({
        ...responseFixture(),
        sourceUrl: "https://example.test/private-result",
      }),
    ).toThrow();
  });
});

function responseFixture(overrides: Record<string, unknown> = {}) {
  return {
    national: scopeFixture(),
    tribunal: null,
    meta: {
      sourceName: "licitor",
      sourceLabel: "Résultats d’adjudication publiés par Licitor",
      methodologyVersion: "licitor_canonical_price_statistics_v1",
      builtAt: "2026-09-07T12:00:00.000Z",
      reviewedAt: "2026-09-07T13:00:00.000Z",
      experimental: true,
      warning: ADJUDICATION_PRICE_STATISTICS_WARNING,
    },
    ...overrides,
  };
}

function scopeFixture(overrides: Record<string, unknown> = {}) {
  return {
    scopeType: "national",
    label: "France entière",
    courtCode: null,
    judicialRegion: null,
    periodStart: "2023-09-07",
    periodEnd: "2026-09-07",
    sampleSize: 3_868,
    reliability: "extended",
    metrics: {
      medianHammerToStartingRatio: 1.9383,
      aboveStartingRate: 0.893485,
      atLeastDoubleRate: 0.485264,
      medianHammerPriceEur: 126_000,
      medianStartingPriceEur: 55_000,
    },
    ...overrides,
  };
}
