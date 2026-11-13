import { describe, expect, it } from "vitest";
import { isParkingProperty } from "./parking";

// Caractérisation (lot 10) : le stationnement se lit par la famille du type (`propertyFamily`). Les
// codes de la base donnent le même résultat qu'avant ; « Appartement avec parking » est un
// appartement (il partait vers l'estimation des parkings).
describe("isParkingProperty", () => {
  it.each([
    ["parking", true],
    ["Garage", true],
    ["Box", true],
    ["apartment", false],
    ["house", false],
    ["building", false],
    ["land", false],
    ["commercial", false],
    ["mixed", false],
    ["other", false],
    ["unknown", false],
    [null, false],
    ["Appartement avec parking", false],
  ])("%s → %s", (propertyType, parking) => {
    expect(isParkingProperty(propertyType)).toBe(parking);
  });
});
