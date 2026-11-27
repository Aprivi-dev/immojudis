import { describe, expect, it } from "vitest";
import { saleVerdict } from "@/lib/sale-verdict";
import type { SaleRisk } from "@/lib/types";

function risk(label: string, severity: number): SaleRisk {
  return { risk_type: label, risk_label: label, severity, evidence: null };
}

describe("saleVerdict", () => {
  it("says the occupation, where the ceiling stands and the first point to settle", () => {
    expect(
      saleVerdict({
        occupancyStatus: "occupied",
        startingPrice: 95_000,
        startingPriceGap: 41_000,
        risks: [risk("Servitude à vérifier", 3), risk("Occupation à confirmer", 5)],
        confidence: "À consolider",
      }),
    ).toMatch(
      /^Bien occupé ; enchère plafond calculée 41\s000\s€ au-dessus de la mise à prix ; à lever en priorité : occupation à confirmer\.$/,
    );
  });

  it("states a ceiling under the starting price as a fact, without advice", () => {
    expect(
      saleVerdict({
        occupancyStatus: "vacant",
        startingPrice: 50_000,
        startingPriceGap: -1_405,
        confidence: "Solide",
      }),
    ).toBe("Bien annoncé libre ; enchère plafond calculée sous la mise à prix.");
  });

  it("falls back on the reliability of the estimate when no risk is a priority", () => {
    expect(
      saleVerdict({
        occupancyStatus: "unknown",
        startingPrice: 100_000,
        startingPriceGap: 2_000,
        risks: [risk("Servitude à vérifier", 2)],
        confidence: "Indicatif",
      }),
    ).toBe(
      "Occupation à confirmer ; enchère plafond calculée à peine au-dessus de la mise à prix ; estimation indicative.",
    );
  });

  it("uses the words of a sale by offers", () => {
    expect(
      saleVerdict({
        occupancyStatus: "rented",
        startingPrice: 100_000,
        startingPriceGap: -5_000,
        ceilingTerm: "offre plafond",
        referencePriceTerm: "première offre possible",
        confidence: null,
      }),
    ).toBe("Bien loué ; offre plafond calculée sous la première offre possible.");
  });

  it("says nothing without a ceiling to compare", () => {
    expect(
      saleVerdict({
        occupancyStatus: "occupied",
        startingPrice: 95_000,
        startingPriceGap: null,
        confidence: null,
      }),
    ).toBeNull();
  });
});
