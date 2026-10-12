import { describe, expect, it } from "vitest";
import { propertyTypeLabel } from "./property-labels";

describe("propertyTypeLabel", () => {
  it.each([
    ["apartment", "Appartement"],
    ["house", "Maison"],
    ["building", "Immeuble"],
    ["land", "Terrain"],
    ["parking", "Garage / Parking"],
    ["commercial", "Local commercial"],
    ["mixed", "Bien mixte"],
    ["other", "Bien à qualifier"],
  ])("labels %s", (code, label) => {
    expect(propertyTypeLabel(code)).toBe(label);
  });

  it("never shows an internal code that has no label yet", () => {
    expect(propertyTypeLabel("agricultural_estate")).toBe("Bien à qualifier");
    expect(propertyTypeLabel(null)).toBe("Bien");
  });

  it("keeps a human-written label untouched", () => {
    expect(propertyTypeLabel("Château")).toBe("Château");
  });
});
