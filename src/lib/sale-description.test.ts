import { describe, expect, it } from "vitest";
import {
  getSaleAiDescription,
  getSaleDisplayDescription,
  hasSaleAiDescription,
} from "./sale-description";
import type { AuctionSale } from "./types";

function sale(overrides: Partial<AuctionSale>): AuctionSale {
  return overrides as AuctionSale;
}

describe("sale AI display description", () => {
  it("uses the LLM display description when available", () => {
    const item = sale({
      llm_display_description: "Synthèse IA prête.",
      about_description: "Description brute héritée.",
      source_description: "Texte source brut.",
      description: "Description collectée brute.",
    });

    expect(getSaleAiDescription(item)).toBe("Synthèse IA prête.");
    expect(getSaleDisplayDescription(item)).toBe("Synthèse IA prête.");
    expect(hasSaleAiDescription(item)).toBe(true);
  });

  it("never falls back to raw source descriptions", () => {
    const item = sale({
      llm_display_description: null,
      about_description: "Description brute héritée.",
      source_description: "Texte source brut.",
      description: "Description collectée brute.",
    });

    expect(getSaleAiDescription(item)).toBeNull();
    expect(getSaleDisplayDescription(item)).not.toContain("Description brute héritée");
    expect(getSaleDisplayDescription(item)).not.toContain("Texte source brut");
    expect(getSaleDisplayDescription(item)).not.toContain("Description collectée brute");
    expect(hasSaleAiDescription(item)).toBe(false);
  });
});
