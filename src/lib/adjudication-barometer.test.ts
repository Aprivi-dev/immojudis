import { describe, expect, it } from "vitest";
import {
  distributionRates,
  filterAdjudicationTribunals,
  tribunalComparisonCsv,
  wilsonShareInterval,
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
      sort: "sample" as const,
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
  it("calcule l'intervalle de Wilson à 95 % d'une part, correct près de 0 et de 1", () => {
    const half = wilsonShareInterval(0.5, 10)!;
    expect(half.low).toBeCloseTo(0.2366, 3);
    expect(half.high).toBeCloseTo(0.7634, 3);
    const none = wilsonShareInterval(0, 10)!;
    expect(none.low).toBeCloseTo(0, 10);
    expect(none.high).toBeCloseTo(0.2775, 3);
    const all = wilsonShareInterval(1, 10)!;
    expect(all.high).toBeCloseTo(1, 10);
    expect(all.low).toBeCloseTo(0.7225, 3);
    // Plus l'effectif est grand, plus l'intervalle se resserre.
    const wide = wilsonShareInterval(0.7, 20)!;
    const narrow = wilsonShareInterval(0.7, 200)!;
    expect(narrow.high - narrow.low).toBeLessThan(wide.high - wide.low);
    expect(wilsonShareInterval(0.5, 0)).toBeNull();
    // Une part hors de 0 à 1 est ramenée dans l'intervalle (règle commune de `stats.ts`).
    expect(wilsonShareInterval(1.2, 10)).toEqual(wilsonShareInterval(1, 10));
    expect(wilsonShareInterval(Number.NaN, 10)).toBeNull();
  });
  it("ne propose plus de tri par multiple médian, l'ordre par effectif est le tri de départ", () => {
    const scopes = [scope("TJ A", 20, 3), scope("TJ B", 90, 1.1), scope("TJ C", 40, 2)];
    const sorted = filterAdjudicationTribunals(scopes, {
      search: "",
      region: "",
      minimumSample: 10,
      sort: "sample",
    });
    expect(sorted.map((item) => item.label)).toEqual(["TJ B", "TJ C", "TJ A"]);
    const byName = filterAdjudicationTribunals(scopes, {
      search: "",
      region: "",
      minimumSample: 10,
      sort: "name",
    });
    expect(byName.map((item) => item.label)).toEqual(["TJ A", "TJ B", "TJ C"]);
  });
});
