import { describe, expect, it } from "vitest";
import {
  ANALYSIS_RECURRING_CURRENCY,
  ANALYSIS_RECURRING_INTERVAL,
  ANALYSIS_RECURRING_INTERVAL_COUNT,
  ANALYSIS_RECURRING_PRICE_CENTS,
  DEFAULT_ANALYSIS_OFFER_LABEL,
  analysisOfferLabelAmountsCents,
  analysisOfferLabelMatchesPrice,
  resolveAnalysisOfferLabel,
} from "./analysis-offer";

describe("approved Analyse offer", () => {
  it("keeps the local recurring contract at 29 EUR per month", () => {
    expect(ANALYSIS_RECURRING_PRICE_CENTS).toBe(2_900);
    expect(ANALYSIS_RECURRING_CURRENCY).toBe("eur");
    expect(ANALYSIS_RECURRING_INTERVAL).toBe("month");
    expect(ANALYSIS_RECURRING_INTERVAL_COUNT).toBe(1);
    expect(DEFAULT_ANALYSIS_OFFER_LABEL).toBe("29 € TTC / mois");
  });

  it("accepts only a public label that states the billed price", () => {
    for (const label of [
      DEFAULT_ANALYSIS_OFFER_LABEL,
      "29 € / mois",
      "29,00 € TTC par mois",
      "29 EUR / mois",
      "€29 / mois",
      "29 euros TTC / mois",
      "29 €/mois",
    ]) {
      expect(analysisOfferLabelMatchesPrice(label), label).toBe(true);
    }
    for (const label of [
      "39 € TTC / mois",
      "2,90 € / mois",
      "290 € / mois",
      "29,50 € / mois",
      "19 € puis 29 € / mois",
      "Sur devis",
      "mois",
    ]) {
      expect(analysisOfferLabelMatchesPrice(label), label).toBe(false);
    }
  });

  it("keeps the default label consistent with the billed price", () => {
    expect(analysisOfferLabelMatchesPrice(DEFAULT_ANALYSIS_OFFER_LABEL)).toBe(true);
    expect(analysisOfferLabelAmountsCents("1 290,50 €")).toEqual([129_050]);
    expect(ANALYSIS_RECURRING_PRICE_CENTS / 100).toBe(29);
  });

  it("falls back to the approved public label when no override is set", () => {
    expect(resolveAnalysisOfferLabel(null)).toBe("29 € TTC / mois");
    expect(resolveAnalysisOfferLabel("  ")).toBe("29 € TTC / mois");
    expect(resolveAnalysisOfferLabel("29 € / mois")).toBe("29 € / mois");
  });
});
