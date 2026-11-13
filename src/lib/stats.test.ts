import { describe, expect, it } from "vitest";
import { wilsonLowerBound } from "@/lib/pepite-policy";
import { wilsonInterval } from "@/lib/tribunal-listing-statistics";
import { median, quantile, quantileSorted, WILSON_Z_95, wilsonInterval95 } from "@/lib/stats";

// Copies des deux formules d'origine, figées AVANT la fusion (lot 4a, n° 77) : elles servent de
// référence pour montrer que `stats.ts` ne change aucun résultat des deux appelants.
function legacyPepiteLowerBound(share: number, sample: number): number {
  const z = 1.959964;
  if (!(sample > 0) || !Number.isFinite(share)) return 0;
  const p = Math.min(1, Math.max(0, share));
  const z2 = z ** 2;
  const denominator = 1 + z2 / sample;
  const center = p + z2 / (2 * sample);
  const margin = z * Math.sqrt((p * (1 - p)) / sample + z2 / (4 * sample ** 2));
  return Math.max(0, (center - margin) / denominator);
}

function legacyRound(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function legacyTribunalInterval(successes: number, total: number) {
  const z = 1.959964;
  const proportion = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = (proportion + z2 / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((proportion * (1 - proportion)) / total + z2 / (4 * total * total))) /
    denominator;
  return {
    low: legacyRound(Math.max(0, centre - margin), 6),
    high: legacyRound(Math.min(1, centre + margin), 6),
  };
}

describe("wilsonInterval95", () => {
  it("garde une seule constante : 1,959964", () => {
    expect(WILSON_Z_95).toBe(1.959964);
  });

  it("donne les valeurs de référence de la règle des pépites", () => {
    // Intervalle de la part 0,7 : [0,40 ; 0,89] sur 10, [0,52 ; 0,83] sur 30, [0,60 ; 0,78] sur 100.
    expect(wilsonInterval95(0.7, 10)?.low).toBeCloseTo(0.397, 2);
    expect(wilsonInterval95(0.7, 30)?.low).toBeCloseTo(0.52, 2);
    expect(wilsonInterval95(0.7, 100)?.low).toBeCloseTo(0.6, 2);
    expect(wilsonInterval95(0.7, 10)?.high).toBeCloseTo(0.89, 2);
  });

  it("reste dans [0, 1], y compris près de 0 et de 1", () => {
    const lowEdge = wilsonInterval95(0, 10);
    const highEdge = wilsonInterval95(1, 10);
    expect(lowEdge?.low).toBe(0);
    expect(lowEdge?.high).toBeCloseTo(0.2775, 3);
    expect(highEdge?.low).toBeCloseTo(0.7225, 3);
    expect(highEdge?.high).toBeCloseTo(1, 12);
    expect(highEdge?.high).toBeLessThanOrEqual(1);
  });

  it("refuse un effectif nul ou négatif et une part non finie", () => {
    expect(wilsonInterval95(0.5, 0)).toBeNull();
    expect(wilsonInterval95(0.5, -3)).toBeNull();
    expect(wilsonInterval95(0.5, Number.NaN)).toBeNull();
    expect(wilsonInterval95(Number.NaN, 10)).toBeNull();
    expect(wilsonInterval95(Number.POSITIVE_INFINITY, 10)).toBeNull();
  });

  it("ramène une part hors de [0, 1] dans cet intervalle", () => {
    expect(wilsonInterval95(1.4, 20)).toEqual(wilsonInterval95(1, 20));
    expect(wilsonInterval95(-0.2, 20)).toEqual(wilsonInterval95(0, 20));
  });
});

describe("caractérisation : les deux appelants gardent leurs résultats", () => {
  it("wilsonLowerBound (pépites) est identique à la formule d'origine, bit à bit", () => {
    const differences: string[] = [];
    for (let sample = 1; sample <= 400; sample += 1) {
      for (
        let successes = 0;
        successes <= sample;
        successes += Math.max(1, Math.floor(sample / 25))
      ) {
        const share = successes / sample;
        if (wilsonLowerBound(share, sample) !== legacyPepiteLowerBound(share, sample)) {
          differences.push(`${successes}/${sample}`);
        }
      }
    }
    expect(differences).toEqual([]);
    // Cas dégénérés de l'ancienne fonction : 0, jamais une exception.
    expect(wilsonLowerBound(0.5, 0)).toBe(0);
    expect(wilsonLowerBound(0.5, -1)).toBe(0);
    expect(wilsonLowerBound(Number.NaN, 10)).toBe(0);
    expect(wilsonLowerBound(1.7, 10)).toBe(legacyPepiteLowerBound(1.7, 10));
  });

  it("wilsonInterval (tribunaux) est identique à la formule d'origine, arrondi au millionième", () => {
    // Une seule assertion sur la liste des écarts : 45 000 `expect` ralentiraient le test pour rien.
    const differences: string[] = [];
    for (let total = 1; total <= 300; total += 1) {
      for (let successes = 0; successes <= total; successes += 1) {
        const actual = wilsonInterval(successes, total);
        const expected = legacyTribunalInterval(successes, total);
        if (actual?.low !== expected.low || actual?.high !== expected.high) {
          differences.push(`${successes}/${total}`);
        }
      }
    }
    expect(differences).toEqual([]);
  });

  it("wilsonInterval garde ses refus : effectif nul, non entier, succès hors plage", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(wilsonInterval(1, 2.5)).toBeNull();
    expect(wilsonInterval(1.5, 4)).toBeNull();
    expect(wilsonInterval(-1, 4)).toBeNull();
    expect(wilsonInterval(5, 4)).toBeNull();
    expect(wilsonInterval(5, 10)).toEqual({ low: 0.236593, high: 0.763407 });
  });
});

// Copies des quantiles et médianes d'origine, figées AVANT la fusion (lot 9 A, n° 15) : deux formes
// de médiane (valeur centrale ou moyenne des deux centrales ; interpolation des tribunaux) et trois
// écritures de l'interpolation linéaire (type 7). Elles montrent que `stats.ts` rend les mêmes
// valeurs, à l'arrondi de la dernière décimale binaire près pour l'interpolation.
function legacyMiddleMedian(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function legacyTribunalQuantile(values: number[], probability: number): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = ordered[lowerIndex]!;
  const upper = ordered[upperIndex]!;
  return lower + (upper - lower) * (position - lowerIndex);
}

function legacyMarketAnalyticsPercentile(values: number[], percentile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const ratio = index - lower;
  return sorted[lower] * (1 - ratio) + sorted[upper] * ratio;
}

const SAMPLES: number[][] = [
  [],
  [5],
  [9, 1, 5],
  [1, 2, 3, 10],
  [30, 34, 36, 40],
  [0.1, 0.3],
  [1_250.5, 980, 3_400.25, 2_100, 1_875.75, 2_640, 1_999.99],
  [120_000, 85_000, 99_000, 150_000, 72_500, 230_000, 64_000, 101_000],
  Array.from({ length: 37 }, (_, index) => ((index * 7919) % 101) / 3),
];
const PROBABILITIES = [0, 0.1, 0.25, 0.5, 0.75, 0.8, 0.9, 1];

describe("quantile et médiane", () => {
  it("rendent la même médiane que les copies « valeur centrale » (loyers, départements, historique)", () => {
    for (const sample of SAMPLES) expect(median(sample)).toBe(legacyMiddleMedian(sample));
  });

  it("rendent les mêmes quantiles que les copies des tribunaux, de l'estimation et du marché", () => {
    for (const sample of SAMPLES) {
      const sorted = [...sample].sort((a, b) => a - b);
      for (const p of PROBABILITIES) {
        const expected = legacyTribunalQuantile(sample, p);
        expect(quantile(sample, p)).toBe(expected);
        expect(quantileSorted(sorted, p)).toBe(expected);
        const marketValue = legacyMarketAnalyticsPercentile(sample, p);
        if (expected == null) expect(marketValue).toBeNull();
        else expect(quantile(sample, p)).toBeCloseTo(marketValue!, 9);
      }
    }
  });

  it("donne la médiane des tribunaux à l'arrondi binaire près", () => {
    for (const sample of SAMPLES) {
      const expected = legacyTribunalQuantile(sample, 0.5);
      if (expected == null) expect(median(sample)).toBeNull();
      else expect(median(sample)).toBeCloseTo(expected, 9);
    }
  });

  it("ignorent les valeurs non finies, comme la médiane des loyers", () => {
    expect(median([Number.NaN, 10])).toBe(10);
    expect(quantile([Number.POSITIVE_INFINITY, 4, 2], 0.5)).toBe(3);
    expect(median([Number.NaN])).toBeNull();
  });
});
