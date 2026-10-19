import { describe, expect, it } from "vitest";
import {
  buildCancellationConfirmationMessage,
  buildPaymentFailedMessage,
  buildTrialEndingMessage,
} from "./billing-notices";

describe("buildCancellationConfirmationMessage", () => {
  const base = {
    from: "Immojudis <alertes@immojudis.com>",
    to: "abonne@example.test",
    appUrl: "https://immojudis.com",
    accessEndsAt: Date.UTC(2026, 10, 20, 12) / 1000,
  };

  it("confirms the receipt, the end date and that the Découverte account remains", () => {
    const message = buildCancellationConfirmationMessage({ ...base, kind: "scheduled" });
    expect(message.subject).toBe("Confirmation de votre résiliation");
    expect(message.text).toContain("bien reçu votre demande de résiliation");
    expect(message.text).toContain("prend fin le 20 novembre 2026");
    expect(message.text).toContain("Votre compte Découverte et vos données restent accessibles.");
    expect(message.text).not.toContain("aucun montant");
    expect(message.html).toContain('href="https://immojudis.com/compte"');
  });

  it("states that nothing is charged when the trial is still running", () => {
    const message = buildCancellationConfirmationMessage({
      ...base,
      kind: "scheduled",
      trialing: true,
    });
    expect(message.text).toContain("aucun montant ne sera prélevé");
  });

  it("says the contract is over for an immediate cancellation", () => {
    const message = buildCancellationConfirmationMessage({ ...base, kind: "immediate" });
    expect(message.text).toContain("a pris fin le 20 novembre 2026");
    expect(message.text).not.toContain("reste ouvert");
  });
});

describe("buildPaymentFailedMessage", () => {
  const base = { from: "Immojudis <alertes@immojudis.com>", to: "abonne@example.test" };

  it("tells the subscriber how long access stays open and where to fix the card", () => {
    const message = buildPaymentFailedMessage({
      ...base,
      appUrl: "https://immojudis.com",
      nextAttemptAt: Date.UTC(2026, 9, 15, 12) / 1000,
    });
    expect(message.subject).toBe("Votre paiement Immojudis n'a pas abouti");
    // Same wording as § 4 of the conditions générales.
    expect(message.text).toContain(
      "Votre accès Analyse reste ouvert 7 jours à compter de la fin de la période payée pour vous permettre de mettre à jour votre moyen de paiement ; la mensualité reste due. Passé ce délai sans paiement, l’accès est suspendu. Votre compte Découverte et vos données restent accessibles.",
    );
    expect(message.text).toContain("le 15 octobre 2026");
    expect(message.text).toContain("Montant de l’abonnement : 59 € TTC / mois");
    expect(message.text).toContain("Résilier mon abonnement");
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
    const message = buildTrialEndingMessage({ ...base, trialEnd, priceLabel: "59 € TTC / mois" });
    expect(message.text).toContain(
      "le premier paiement est prélevé le 20 octobre 2026 : 59 € TTC / mois",
    );
    expect(message.text).toContain("Résilier mon abonnement");
    expect(message.text).toContain("https://immojudis.com/compte");
    expect(message.text).toContain("L’équipe Immojudis");
    expect(message.text).toContain("droit de rétractation de 14 jours");
    expect(message.text).toContain("https://immojudis.com/mes-droits");
    expect(message.html).toContain('href="https://immojudis.com/compte"');
  });
});
