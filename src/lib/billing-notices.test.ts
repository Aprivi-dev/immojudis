import { describe, expect, it } from "vitest";
import { buildPaymentFailedMessage, buildTrialEndingMessage } from "./billing-notices";

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
    expect(message.text).toContain("Montant de l’abonnement : 29 € TTC / mois");
    expect(message.text).toContain("Gérer mon abonnement");
    expect(message.text).toContain("L’équipe Immojudis");
    expect(message.text).toContain("https://immojudis.com/compte");
    expect(message.html).toContain('href="https://immojudis.com/compte"');
  });

  it("falls back to a generic retry sentence when Stripe gives no date", () => {
    const message = buildPaymentFailedMessage({ ...base, appUrl: "https://immojudis.com" });
    expect(message.text).toContain("dans les prochains jours");
  });
});

describe("buildTrialEndingMessage", () => {
  const base = {
    from: "Immojudis <alertes@immojudis.com>",
    to: "abonne@example.test",
    appUrl: "https://immojudis.com",
  };
  const trialEnd = Date.UTC(2026, 9, 20, 12) / 1000;

  it("puts the real end date in the subject instead of a fixed number of days", () => {
    const message = buildTrialEndingMessage({ ...base, trialEnd });
    expect(message.subject).toBe("Votre essai Immojudis Analyse se termine le 20 octobre 2026");
    expect(message.subject).not.toContain("dans 3 jours");
  });

  it("gives the amount, the date of the first payment, how to cancel and a signature", () => {
    const message = buildTrialEndingMessage({ ...base, trialEnd, priceLabel: "29 € TTC / mois" });
    expect(message.text).toContain(
      "le premier paiement est prélevé le 20 octobre 2026 : 29 € TTC / mois",
    );
    expect(message.text).toContain("Gérer mon abonnement");
    expect(message.text).toContain("https://immojudis.com/compte");
    expect(message.text).toContain("L’équipe Immojudis");
    expect(message.text).toContain("droit de rétractation de 14 jours");
    expect(message.text).toContain("https://immojudis.com/mes-droits");
    expect(message.html).toContain('href="https://immojudis.com/compte"');
  });
});
