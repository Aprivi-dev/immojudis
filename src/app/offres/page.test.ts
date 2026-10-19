import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ legalReady: vi.fn() }));
vi.mock("@/lib/legal-documents", () => ({
  legalPublisherConfigurationStatus: mocks.legalReady,
}));
vi.mock("./offers-page", () => ({ OffersPage: () => null }));

import { generateMetadata } from "./page";

describe("métadonnées de /offres", () => {
  beforeEach(() => {
    mocks.legalReady.mockReturnValue({ ready: true, missing: [] });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("n'annonce aucun prix tant que l'offre est fermée (prix Stripe absent)", () => {
    vi.stubEnv("STRIPE_ANALYSIS_PRICE_ID", "");
    const description = String(generateMetadata().description);
    expect(description).toBe(
      "Découverte est gratuite. Analyse, l’offre d’aide à la décision (enchère plafond, alertes quotidiennes, comparables), n’est pas encore ouverte à la souscription.",
    );
    expect(description).not.toMatch(/€|TTC|\d/);
    expect(description.length).toBeLessThanOrEqual(160);
  });

  it("n'annonce aucun prix tant que l'identité légale n'est pas publiée", () => {
    vi.stubEnv("STRIPE_ANALYSIS_PRICE_ID", "price_123");
    mocks.legalReady.mockReturnValue({ ready: false, missing: ["raison sociale"] });
    expect(String(generateMetadata().description)).toContain(
      "n’est pas encore ouverte à la souscription",
    );
  });

  it("reprend le libellé public quand l'offre est ouverte", () => {
    vi.stubEnv("STRIPE_ANALYSIS_PRICE_ID", "price_123");
    vi.stubEnv("NEXT_PUBLIC_ANALYSIS_OFFER_LABEL", "");
    const description = String(generateMetadata().description);
    expect(description).toContain("59 € TTC / mois");
    expect(description.length).toBeLessThanOrEqual(160);
  });

  it("garde le canonical et le titre", () => {
    vi.stubEnv("STRIPE_ANALYSIS_PRICE_ID", "");
    const metadata = generateMetadata();
    expect(metadata.alternates?.canonical).toBe("/offres");
    expect(metadata.title).toBe("Offres Découverte et Analyse");
  });
});
