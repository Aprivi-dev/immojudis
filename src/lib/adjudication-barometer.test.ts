import { describe, expect, it } from "vitest";
import {
  distributionRates,
  filterAdjudicationTribunals,
  tribunalComparisonCsv,
} from "./adjudication-barometer";
import { bidBands } from "./adjudication-distributions";
import type { AdjudicationPriceStatisticsScope } from "./adjudication-price-statistics";

function scope(
  label: string,
  sampleSize: number,
  multiple: number,
): AdjudicationPriceStatisticsScope {
  return {
    scopeType: "tribunal",
    courtCode: label,
    label,
    judicialRegion: "Lyon",
    periodStart: "2023-09-20",
    periodEnd: "2026-09-20",
    sampleSize,
    reliability: "descriptive",
    metrics: {
      medianHammerToStartingRatio: multiple,
      medianStartingPriceEur: 50_000,
      medianHammerPriceEur: 90_000,
      aboveStartingRate: 0.8,
      atLeastDoubleRate: 0.4,
    },
  };
}

describe("baromètre descriptif", () => {
  it("calcule les taux sur les effectifs, sans additionner les parts arrondies", () => {
    const counts = [1, 2, 3, 4, 7];
    expect(
      distributionRates({
        sampleSize: 17,
        hammerPriceMiddle50Eur: { p25: 1, p75: 2 },
        ratioMiddle50: { p25: 1, p75: 2 },
        bidDistribution: bidBands.map((band, index) => ({
          band,
          count: counts[index],
          share: Number((counts[index] / 17).toFixed(6)),
        })),
      }),
    ).toEqual({ aboveStartingRate: 14 / 17, atLeastDoubleRate: 7 / 17 });
  });
  it("combine recherche accentuée, ressort, seuil et tri sans muter les données", () => {
    const scopes = [
      scope("TJ Saint-Étienne", 40, 1.4),
      scope("TJ Lyon", 90, 1.9),
      scope("TJ Paris", 20, 2.1),
    ];
    const filters = {
      search: "saint-etienne",
      region: "Lyon",
      minimumSample: 30,
      sort: "ratio" as const,
    };
    expect(filterAdjudicationTribunals(scopes, filters).map((item) => item.label)).toEqual([
      "TJ Saint-Étienne",
    ]);
    expect(
      filterAdjudicationTribunals(scopes, { ...filters, search: "" }).map((item) => item.label),
    ).toEqual(["TJ Lyon", "TJ Saint-Étienne"]);
    expect(scopes[0].label).toBe("TJ Saint-Étienne");
  });
  it("exporte la sélection, la période et la source en neutralisant les formules CSV", () => {
    const csv = tribunalComparisonCsv([scope('=HYPERLINK("https://example.test")', 30, 1.7)]);
    expect(csv).toContain('\uFEFF"Tribunal";');
    expect(csv).toContain('"\'=HYPERLINK(""https://example.test"")"');
  });
});
