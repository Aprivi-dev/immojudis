import { describe, expect, it } from "vitest";
import { formatCompactAddress, formatCurrency, formatNumber, formatPropertyArea } from "./format";

describe("property format helpers", () => {
  it("formats arbitrary currencies without decimals", () => {
    expect(formatCurrency(178000, "EUR")).toContain("178");
    expect(formatCurrency(178000, "EUR")).toContain("€");
  });

  it("formats missing numeric values consistently", () => {
    expect(formatNumber(null)).toBe("—");
    expect(formatPropertyArea(undefined)).toBe("Surface non communiquée");
  });

  it("compacts address parts and removes empty values", () => {
    expect(formatCompactAddress(["63 Place", "", null, "Bordeaux", "France"])).toBe(
      "63 Place, Bordeaux, France",
    );
  });
});
