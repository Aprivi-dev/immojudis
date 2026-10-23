import { describe, expect, it } from "vitest";
import {
  MARKET_JACKKNIFE_MIN_COMPARABLES,
  MARKET_NON_JACKKNIFE_MIN_COMPARABLES,
  MARKET_WIDEN_UNTIL_COMPARABLES,
} from "@/lib/market-comparable-minimums";
import {
  MARKET_GAP_BAND_MIN_COMPARABLES,
  MARKET_GAP_BAND_MIN_COMPARABLES_JACKKNIFE,
} from "@/lib/market-gap-band";
import { shouldWidenRadius } from "@/lib/market-server/radius-widening";

const base = { segment: "apartment", areaKind: "urban" as const };

describe("constantes partagées moteur / porte publique", () => {
  it("la porte publique relit les mêmes effectifs que le moteur", () => {
    expect(MARKET_GAP_BAND_MIN_COMPARABLES_JACKKNIFE).toBe(MARKET_JACKKNIFE_MIN_COMPARABLES);
    expect(MARKET_GAP_BAND_MIN_COMPARABLES).toBe(MARKET_NON_JACKKNIFE_MIN_COMPARABLES);
  });

  it("l'élargissement vise au moins l'effectif qui donne l'intervalle jackknife", () => {
    expect(MARKET_WIDEN_UNTIL_COMPARABLES).toBeGreaterThanOrEqual(
      MARKET_GAP_BAND_MIN_COMPARABLES_JACKKNIFE,
    );
    expect(MARKET_WIDEN_UNTIL_COMPARABLES).toBeGreaterThan(4);
  });
});

describe("shouldWidenRadius", () => {
  it("élargit toujours tant que l'estimation n'est pas exploitable", () => {
    expect(
      shouldWidenRadius({ ...base, actionable: false, sampleSize: 2, nextRadiusM: 2_000 }),
    ).toBe(true);
  });

  it("n'arrête plus l'élargissement à 4 ou 5 comparables", () => {
    for (const sampleSize of [4, 5]) {
      expect(shouldWidenRadius({ ...base, actionable: true, sampleSize, nextRadiusM: 300 })).toBe(
        true,
      );
    }
  });

  it("s'arrête dès que l'effectif exigé par la porte est atteint", () => {
    expect(
      shouldWidenRadius({
        ...base,
        actionable: true,
        sampleSize: MARKET_WIDEN_UNTIL_COMPARABLES,
        nextRadiusM: 300,
      }),
    ).toBe(false);
  });

  it("ne dépasse pas le rayon maximal admis par la porte pour un appartement urbain", () => {
    expect(
      shouldWidenRadius({ ...base, actionable: true, sampleSize: 4, nextRadiusM: 1_000 }),
    ).toBe(true);
    expect(
      shouldWidenRadius({ ...base, actionable: true, sampleSize: 4, nextRadiusM: 2_000 }),
    ).toBe(false);
  });

  it("admet 2 000 m pour une maison ou un appartement rural", () => {
    expect(
      shouldWidenRadius({
        segment: "house",
        areaKind: "urban",
        actionable: true,
        sampleSize: 4,
        nextRadiusM: 2_000,
      }),
    ).toBe(true);
    expect(
      shouldWidenRadius({
        segment: "apartment",
        areaKind: "rural",
        actionable: true,
        sampleSize: 4,
        nextRadiusM: 2_000,
      }),
    ).toBe(true);
    expect(
      shouldWidenRadius({
        segment: "house",
        areaKind: "urban",
        actionable: true,
        sampleSize: 4,
        nextRadiusM: 3_000,
      }),
    ).toBe(false);
  });
});
