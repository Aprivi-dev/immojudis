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

  it("falls back to the about description when the LLM display description is missing", () => {
    const item = sale({
      llm_display_description: null,
      about_description: "Description synthétique disponible.",
      source_description: "Texte source brut.",
      description: "Description collectée brute.",
    });

    expect(getSaleAiDescription(item)).toBeNull();
    expect(getSaleDisplayDescription(item)).toBe("Description synthétique disponible.");
    expect(hasSaleAiDescription(item)).toBe(false);
  });

  it("uses source descriptions before generating a structured fallback", () => {
    const item = sale({
      llm_display_description: null,
      about_description: null,
      source_description: "Texte source exploitable.",
      description: "Description collectée brute.",
    });

    expect(getSaleDisplayDescription(item)).toBe("Texte source exploitable.");
  });

  it("generates a factual fallback instead of showing a pending message", () => {
    const item = sale({
      llm_display_description: null,
      about_description: null,
      source_description: null,
      description: null,
      city: "Bordeaux",
      department: "33",
      tribunal_name: "TJ Bordeaux",
      property_type: "apartment",
      starting_price_eur: 92_000,
      sale_date: "2026-10-15T09:30:00+02:00",
      app_surface_m2: 42.6,
      rooms_count: 2,
      occupancy_status: "unknown",
    });

    expect(getSaleDisplayDescription(item)).toContain("Ce bien situé à Bordeaux, 33");
    expect(getSaleDisplayDescription(item)).toContain("92");
    expect(getSaleDisplayDescription(item)).not.toContain("Synthèse IA en cours");
  });
});
