import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readiness: vi.fn() }));
vi.mock("@/lib/analysis-checkout-readiness", () => ({
  analysisCheckoutReadiness: mocks.readiness,
}));
vi.mock("./offers-page", () => ({ OffersPage: () => null }));

import { generateMetadata } from "./page";

const readiness = (open: boolean, missing: string[] = []) => ({
  open,
  missing,
  launchOfferActive: false,
});

describe("métadonnées de /offres", () => {
  beforeEach(() => {
    mocks.readiness.mockReturnValue(readiness(true));
  });

  it("n'annonce aucun prix tant que les paiements ne sont pas ouverts", () => {
    mocks.readiness.mockReturnValue(readiness(false, ["STRIPE_ANALYSIS_PRICE_ID"]));
    const description = String(generateMetadata().description);
    expect(description).toBe(
      "Découverte est gratuite. Analyse, l’offre d’aide à la décision (enchère plafond, alertes quotidiennes, comparables), n’est pas encore ouverte à la souscription.",
    );
    expect(description).not.toMatch(/€|TTC|\d/);
    expect(description.length).toBeLessThanOrEqual(160);
  });

  it("utilise la même règle d'ouverture que le checkout (secret de webhook compris)", () => {
    mocks.readiness.mockReturnValue(readiness(false, ["STRIPE_WEBHOOK_SECRET"]));
    expect(String(generateMetadata().description)).toContain(
      "n’est pas encore ouverte à la souscription",
    );
    expect(mocks.readiness).toHaveBeenCalled();
  });

  it("reprend le libellé public quand l'offre est ouverte", () => {
    vi.stubEnv("NEXT_PUBLIC_ANALYSIS_OFFER_LABEL", "");
    const description = String(generateMetadata().description);
    expect(description).toContain("59 € TTC / mois");
    expect(description.length).toBeLessThanOrEqual(160);
    vi.unstubAllEnvs();
  });

  it("garde le canonical et le titre", () => {
    mocks.readiness.mockReturnValue(readiness(false));
    const metadata = generateMetadata();
    expect(metadata.alternates?.canonical).toBe("/offres");
    expect(metadata.title).toBe("Offres Découverte et Analyse");
  });
});
