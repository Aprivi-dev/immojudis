import { describe, expect, it } from "vitest";
import { cleanSaleTitle, saleDisplayTitle } from "@/lib/sale-title";

describe("cleanSaleTitle", () => {
  it("removes recommended ceiling wording and amount from listing titles", () => {
    expect(cleanSaleTitle("Appartement T2 Bordeaux : plafond conseillé à 137 800 €")).toBe(
      "Appartement T2 Bordeaux",
    );
    expect(cleanSaleTitle("Maison familiale - Plafond recommandé 220 000 euros")).toBe(
      "Maison familiale",
    );
    expect(cleanSaleTitle("Terrain constructible · plafond conseille a XX")).toBe(
      "Terrain constructible",
    );
  });

  it("falls back to the property type when the title only contains a ceiling mention", () => {
    expect(
      saleDisplayTitle({ title: "Plafond conseillé à 137 800 €", property_type: "apartment" }),
    ).toBe("Appartement");
  });
});
