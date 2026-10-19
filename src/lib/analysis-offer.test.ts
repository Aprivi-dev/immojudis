import { describe, expect, it } from "vitest";
import {
  ANALYSIS_RECURRING_CURRENCY,
  ANALYSIS_RECURRING_INTERVAL,
  ANALYSIS_RECURRING_INTERVAL_COUNT,
  ANALYSIS_RECURRING_PRICE_CENTS,
  DEFAULT_ANALYSIS_OFFER_LABEL,
  analysisOfferLabelAmountsCents,
  analysisOfferLabelMatchesPrice,
  offersPageDescription,
  OFFERS_DESCRIPTION_MAX_LENGTH,
  resolveAnalysisOfferLabel,
} from "./analysis-offer";

describe("offersPageDescription", () => {
  it("states no price while the offer is closed", () => {
    const text = offersPageDescription({ open: false, label: "59 € TTC / mois" });
    expect(text).toContain("n’est pas encore ouverte à la souscription");
    expect(text).toContain("alertes quotidiennes");
    expect(text.length).toBeLessThanOrEqual(OFFERS_DESCRIPTION_MAX_LENGTH);
    expect(text).not.toContain("59");
  });

  it("quotes the label once open and stays within 160 characters", () => {
    const text = offersPageDescription({ open: true, label: "59 € TTC / mois" });
    expect(text).toContain("59 € TTC / mois");
    expect(text.length).toBeLessThanOrEqual(OFFERS_DESCRIPTION_MAX_LENGTH);
  });

  it("drops an over-long label instead of overflowing", () => {
    const text = offersPageDescription({ open: true, label: "x".repeat(200) });
    expect(text.length).toBeLessThanOrEqual(OFFERS_DESCRIPTION_MAX_LENGTH);
    expect(text).not.toContain("xxx");
  });
});

describe("approved Analyse offer", () => {
  it("keeps the local recurring contract at 59 EUR per month", () => {
    expect(ANALYSIS_RECURRING_PRICE_CENTS).toBe(5_900);
    expect(ANALYSIS_RECURRING_CURRENCY).toBe("eur");
    expect(ANALYSIS_RECURRING_INTERVAL).toBe("month");
    expect(ANALYSIS_RECURRING_INTERVAL_COUNT).toBe(1);
    expect(DEFAULT_ANALYSIS_OFFER_LABEL).toBe("59 € TTC / mois");
  });

  it("accepts only a public label that states the billed price", () => {
    for (const label of [
      DEFAULT_ANALYSIS_OFFER_LABEL,
      "59 € / mois",
      "59,00 € TTC par mois",
      "59 EUR / mois",
      "€59 / mois",
      "59 euros TTC / mois",
      "59 €/mois",
    ]) {
      expect(analysisOfferLabelMatchesPrice(label), label).toBe(true);
    }
    for (const label of [
      "39 € TTC / mois",
      "2,90 € / mois",
      "290 € / mois",
      "29,50 € / mois",
      "19 € puis 59 € / mois",
      "Sur devis",
      "mois",
    ]) {
      expect(analysisOfferLabelMatchesPrice(label), label).toBe(false);
    }
  });

  it("keeps the default label consistent with the billed price", () => {
    expect(analysisOfferLabelMatchesPrice(DEFAULT_ANALYSIS_OFFER_LABEL)).toBe(true);
    expect(analysisOfferLabelAmountsCents("1 290,50 €")).toEqual([129_050]);
    expect(ANALYSIS_RECURRING_PRICE_CENTS / 100).toBe(59);
  });

  it("falls back to the approved public label when no override is set", () => {
    expect(resolveAnalysisOfferLabel(null)).toBe("59 € TTC / mois");
    expect(resolveAnalysisOfferLabel("  ")).toBe("59 € TTC / mois");
    expect(resolveAnalysisOfferLabel("59 € / mois")).toBe("59 € / mois");
  });
});
