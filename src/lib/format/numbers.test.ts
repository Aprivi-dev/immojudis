import { describe, expect, it } from "vitest";
import {
  formatPercent,
  formatPrice,
  formatPriceWithCents,
  formatRentPerM2,
  formatShareAsPercent,
} from "./numbers";

/** Espaces insécables (fine ou non) ramenées à une espace ordinaire, pour lire les attentes. */
const plain = (text: string) => text.replace(/\s/g, " ");

describe("montants en euros", () => {
  it("garde les centimes quand on les demande, sans décimale sinon", () => {
    expect(plain(formatPriceWithCents(1234.5))).toBe("1 234,50 €");
    expect(plain(formatPriceWithCents(0))).toBe("0,00 €");
    expect(plain(formatPrice(1234.5))).toBe("1 235 €");
    expect(formatPriceWithCents(Number.NaN)).toBe("Prix non communiqué");
    expect(formatPriceWithCents(null)).toBe("Prix non communiqué");
  });

  it("écrit un loyer au mètre carré à une décimale", () => {
    expect(plain(formatRentPerM2(12.46))).toBe("12,5 €/m²");
    expect(plain(formatRentPerM2(9))).toBe("9,0 €/m²");
  });
});

describe("pourcentages", () => {
  it("lit une valeur déjà de 0 à 100", () => {
    expect(formatPercent(12.46)).toBe("12 %");
    expect(formatPercent(12.46, 1)).toBe("12,5 %");
    expect(formatPercent(5, 1, 1)).toBe("5,0 %");
    expect(formatPercent(5.256, 2, 1)).toBe("5,26 %");
    expect(formatPercent(99.95, 3, 3)).toBe("99,950 %");
  });

  it("lit une part de 0 à 1", () => {
    expect(formatShareAsPercent(0.125)).toBe("13 %");
    expect(formatShareAsPercent(0.125, 1)).toBe("12,5 %");
    expect(formatShareAsPercent(0)).toBe("0 %");
    expect(formatShareAsPercent(1)).toBe("100 %");
    expect(formatShareAsPercent(0.0580665, 2)).toBe("5,81 %");
  });

  it("n'affiche jamais une valeur absente comme un pourcentage", () => {
    for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatPercent(value)).toBe("—");
      expect(formatShareAsPercent(value)).toBe("—");
    }
  });
});
