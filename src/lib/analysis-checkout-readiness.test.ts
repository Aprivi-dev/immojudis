import { describe, expect, it } from "vitest";
import {
  analysisCheckoutReadiness,
  assertAnalysisCheckoutOpen,
} from "@/lib/analysis-checkout-readiness";

const COMPLETE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_ready",
  STRIPE_ANALYSIS_PRICE_ID: "price_1AnalysisTest",
  STRIPE_WEBHOOK_SECRET: "whsec_ready",
  RESEND_API_KEY: "re_test",
  ALERT_EMAIL_FROM: "Immojudis <alertes@immojudis.fr>",
  SITE_URL: "https://immojudis.example",
  NEXT_PUBLIC_LEGAL_ENTITY_NAME: "Immojudis SAS",
  NEXT_PUBLIC_LEGAL_ENTITY_FORM: "SAS",
  NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS: "1 rue de Paris, 75001 Paris",
  NEXT_PUBLIC_LEGAL_REGISTRATION: "RCS Paris 000 000 000",
  NEXT_PUBLIC_LEGAL_PUBLICATION_DIRECTOR: "Direction Immojudis",
  NEXT_PUBLIC_LEGAL_CONTACT_EMAIL: "contact@immojudis.fr",
  NEXT_PUBLIC_LEGAL_CONTACT_PHONE: "+33 1 00 00 00 00",
  NEXT_PUBLIC_LEGAL_MEDIATOR_NAME: "Médiateur",
  NEXT_PUBLIC_LEGAL_MEDIATOR_ADDRESS: "2 rue de Lyon, 69001 Lyon",
  NEXT_PUBLIC_LEGAL_MEDIATOR_WEBSITE: "https://mediateur.example",
};

describe("analysisCheckoutReadiness", () => {
  it("est ouvert quand tout est configuré", () => {
    expect(analysisCheckoutReadiness(COMPLETE_ENV)).toEqual({ open: true, missing: [] });
    expect(() => assertAnalysisCheckoutOpen(COMPLETE_ENV)).not.toThrow();
  });

  it("n'est pas ouvert sans secret de webhook, même avec un Price valide", () => {
    const { STRIPE_WEBHOOK_SECRET: _omitted, ...withoutWebhook } = COMPLETE_ENV;
    const readiness = analysisCheckoutReadiness(withoutWebhook);
    expect(readiness.open).toBe(false);
    expect(readiness.missing).toEqual(["STRIPE_WEBHOOK_SECRET"]);
    expect(() => assertAnalysisCheckoutOpen(withoutWebhook)).toThrow(
      /STRIPE_WEBHOOK_SECRET.*checkout est suspendu/,
    );
  });

  it("n'est pas ouvert avec un secret de webhook vide ou blanc", () => {
    expect(analysisCheckoutReadiness({ ...COMPLETE_ENV, STRIPE_WEBHOOK_SECRET: "  " }).open).toBe(
      false,
    );
  });

  it("refuse un Price absent ou mal formé", () => {
    expect(
      analysisCheckoutReadiness({ ...COMPLETE_ENV, STRIPE_ANALYSIS_PRICE_ID: "" }).missing,
    ).toEqual(["STRIPE_ANALYSIS_PRICE_ID"]);
    expect(
      analysisCheckoutReadiness({ ...COMPLETE_ENV, STRIPE_ANALYSIS_PRICE_ID: "prod_123" }).open,
    ).toBe(false);
  });

  it("liste ce qui manque côté identité légale et confirmation contractuelle", () => {
    const readiness = analysisCheckoutReadiness({
      ...COMPLETE_ENV,
      NEXT_PUBLIC_LEGAL_ENTITY_NAME: "",
      RESEND_API_KEY: "",
    });
    expect(readiness.open).toBe(false);
    expect(readiness.missing).toEqual(
      expect.arrayContaining(["NEXT_PUBLIC_LEGAL_ENTITY_NAME", "RESEND_API_KEY"]),
    );
  });
});
