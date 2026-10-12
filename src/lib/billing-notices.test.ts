import { describe, expect, it } from "vitest";
import { buildPaymentFailedMessage } from "./billing-notices";

describe("buildPaymentFailedMessage", () => {
  const base = { from: "Immojudis <alertes@immojudis.com>", to: "abonne@example.test" };

  it("tells the subscriber how long access stays open and where to fix the card", () => {
    const message = buildPaymentFailedMessage({
      ...base,
      appUrl: "https://immojudis.com",
      nextAttemptAt: Date.UTC(2026, 9, 15, 12) / 1000,
    });
    expect(message.subject).toBe("Votre paiement Immojudis n'a pas abouti");
    expect(message.text).toContain("pendant 7 jours");
    expect(message.text).toContain("le 15 octobre 2026");
    expect(message.text).toContain("https://immojudis.com/compte");
    expect(message.html).toContain('href="https://immojudis.com/compte"');
  });

  it("falls back to a generic retry sentence when Stripe gives no date", () => {
    const message = buildPaymentFailedMessage({ ...base, appUrl: "https://immojudis.com" });
    expect(message.text).toContain("dans les prochains jours");
  });
});
