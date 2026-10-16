import { describe, expect, it } from "vitest";
import {
  MARKET_GAP_MAX_DISCOUNT_PCT,
  MARKET_GAP_MIN_DISCOUNT_PCT,
  describeMarketGap,
  isSignificantMarketGap,
  marketDiscountPct,
  resolveMarketGap,
} from "./market-gap";

describe("marketDiscountPct", () => {
  it("garde la formule historique : (valeur - mise à prix) / valeur, arrondie", () => {
    expect(marketDiscountPct(201_400, 140_000)).toBe(30);
    expect(marketDiscountPct(100_000, 110_000)).toBe(-10);
    expect(marketDiscountPct(100_000, 100_000)).toBe(0);
  });

  it.each([
    [null, 100],
    [100_000, null],
    [0, 100],
    [100_000, 0],
    [Number.NaN, 100],
    [100_000, -5],
  ])("renvoie null pour valeur %s et mise à prix %s", (value, price) => {
    expect(marketDiscountPct(value, price)).toBeNull();
  });
});

describe("isSignificantMarketGap", () => {
  it("accepte les bornes (+70 % et -50 % de décote, soit -70 % et +50 % face au marché)", () => {
    expect(MARKET_GAP_MAX_DISCOUNT_PCT).toBe(70);
    expect(MARKET_GAP_MIN_DISCOUNT_PCT).toBe(-50);
    expect(isSignificantMarketGap(70)).toBe(true);
    expect(isSignificantMarketGap(-50)).toBe(true);
    expect(isSignificantMarketGap(0)).toBe(true);
  });

  it("refuse ce qui dépasse les bornes", () => {
    expect(isSignificantMarketGap(71)).toBe(false);
    expect(isSignificantMarketGap(-51)).toBe(false);
    expect(isSignificantMarketGap(95)).toBe(false);
    expect(isSignificantMarketGap(Number.NaN)).toBe(false);
  });
});

describe("resolveMarketGap", () => {
  it("rend le pourcentage d'un écart plausible", () => {
    expect(resolveMarketGap({ estimatedValueEur: 200_000, startingPriceEur: 120_000 })).toEqual({
      status: "gap",
      discountPct: 40,
    });
  });

  it("rend le prix au m² d'un écart aberrant", () => {
    expect(
      resolveMarketGap({ estimatedValueEur: 300_000, startingPriceEur: 30_000, surfaceM2: 60 }),
    ).toEqual({ status: "not_significant", startingPricePerM2: 500 });
  });

  it("n'invente pas de prix au m² sans surface exploitable", () => {
    for (const surfaceM2 of [undefined, null, 0, -3]) {
      expect(
        resolveMarketGap({ estimatedValueEur: 300_000, startingPriceEur: 30_000, surfaceM2 }),
      ).toEqual({ status: "not_significant", startingPricePerM2: null });
    }
  });

  it("est indisponible sans valeur ou sans mise à prix", () => {
    expect(resolveMarketGap({ estimatedValueEur: null, startingPriceEur: 100 })).toEqual({
      status: "unavailable",
    });
    expect(resolveMarketGap({ estimatedValueEur: 100_000, startingPriceEur: 0 })).toEqual({
      status: "unavailable",
    });
  });
});

describe("describeMarketGap", () => {
  it("garde les phrases existantes de la fiche", () => {
    expect(describeMarketGap({ discountPct: 30 })).toBe(
      "La mise à prix est environ 30 % sous la valeur estimée du bien.",
    );
    expect(describeMarketGap({ discountPct: -12 })).toBe(
      "La mise à prix est environ 12 % au-dessus de la valeur estimée du bien.",
    );
    expect(describeMarketGap({ discountPct: 0 })).toBe(
      "La mise à prix est proche de la valeur estimée du bien.",
    );
    expect(describeMarketGap({ discountPct: null })).toBeNull();
  });

  it("n'affiche aucun pourcentage pour un écart non significatif", () => {
    const text = describeMarketGap({
      discountPct: null,
      discountNotSignificant: true,
      startingPricePerM2: 1_250,
    });
    expect(text).toMatch(/^Écart non significatif : mise à prix de 1\s250 €\/m²\.$/);
    expect(text).not.toContain("%");
  });

  it("garde la mention seule quand le prix au m² est inconnu", () => {
    expect(
      describeMarketGap({
        discountPct: null,
        discountNotSignificant: true,
        startingPricePerM2: null,
      }),
    ).toBe("Écart non significatif.");
  });
});
