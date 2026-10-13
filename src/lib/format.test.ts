import { describe, expect, it } from "vitest";
import {
  formatCompactAddress,
  formatCurrency,
  formatNumber,
  formatPrice,
  formatPropertyArea,
  formatStartingPrice,
} from "./format";

describe("property format helpers", () => {
  it("formats arbitrary currencies without decimals", () => {
    expect(formatCurrency(178000, "EUR")).toContain("178");
    expect(formatCurrency(178000, "EUR")).toContain("€");
  });

  it("formats missing numeric values consistently", () => {
    expect(formatNumber(null)).toBe("—");
    expect(formatPropertyArea(undefined)).toBe("Surface non communiquée");
  });

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "never formats %s as an amount",
    (value) => {
      expect(formatPrice(value)).toBe("Prix non communiqué");
      expect(formatStartingPrice(value)).toBe("Prix non communiqué");
    },
  );

  it("keeps a zero amount for fees, margins and cash flows", () => {
    expect(formatPrice(0).replace(/\s/g, " ")).toBe("0 €");
    expect(formatPrice(178_000)).toContain("178");
  });

  it("treats a zero starting price as not communicated", () => {
    expect(formatStartingPrice(0)).toBe("Prix non communiqué");
    expect(formatStartingPrice(-5)).toBe("Prix non communiqué");
    expect(formatStartingPrice(45_000)).toBe(formatPrice(45_000));
  });

  it("compacts address parts and removes empty values", () => {
    expect(formatCompactAddress(["63 Place", "", null, "Bordeaux", "France"])).toBe(
      "63 Place, Bordeaux, France",
    );
  });
});
