import { describe, expect, it } from "vitest";
import {
  ANALYSIS_RECURRING_CURRENCY,
  ANALYSIS_RECURRING_INTERVAL,
  ANALYSIS_RECURRING_INTERVAL_COUNT,
  ANALYSIS_RECURRING_PRICE_CENTS,
  DEFAULT_ANALYSIS_OFFER_LABEL,
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

  it("falls back to the approved public label when no override is set", () => {
    expect(resolveAnalysisOfferLabel(null)).toBe("29 € TTC / mois");
    expect(resolveAnalysisOfferLabel("  ")).toBe("29 € TTC / mois");
    expect(resolveAnalysisOfferLabel("29 € / mois")).toBe("29 € / mois");
  });
});
