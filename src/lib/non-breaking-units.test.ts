import { describe, expect, it } from "vitest";
import { nonBreakingUnits } from "./non-breaking-units";

const NBSP = " ";

describe("nonBreakingUnits", () => {
  it("colle l'unité au nombre : €, m², %, €/m²", () => {
    expect(nonBreakingUnits("59 € TTC / mois")).toBe(`59${NBSP}€${NBSP}TTC / mois`);
    expect(nonBreakingUnits("Appartement 45 m² à Lyon")).toBe(`Appartement 45${NBSP}m² à Lyon`);
    expect(nonBreakingUnits("2 850 €/m² contre 3 100 €/m²")).toBe(
      `2 850${NBSP}€/m² contre 3 100${NBSP}€/m²`,
    );
    expect(nonBreakingUnits("12 % sous le marché")).toBe(`12${NBSP}% sous le marché`);
  });

  it("laisse intact ce qui n'est pas un nombre suivi d'une unité", () => {
    expect(nonBreakingUnits("Mise à prix € à confirmer")).toBe("Mise à prix € à confirmer");
    expect(nonBreakingUnits("2 mois offerts")).toBe("2 mois offerts");
    expect(nonBreakingUnits("3 m²x")).toBe("3 m²x");
    expect(nonBreakingUnits("")).toBe("");
  });

  it("est idempotent", () => {
    const once = nonBreakingUnits("59 € TTC / mois, 45 m², 12 %");
    expect(nonBreakingUnits(once)).toBe(once);
  });
});
