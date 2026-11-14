import { describe, expect, it } from "vitest";
import { adminSecondFactorExposures } from "@/lib/admin.server";

/** Paiement Analyse ouvert : configuration complète (même jeu que analysis-checkout-readiness.test.ts). */
const PAYMENT_OPEN = {
  STRIPE_SECRET_KEY: "sk_live_ready",
  STRIPE_ANALYSIS_PRICE_ID: "price_1AnalysisLive",
  STRIPE_WEBHOOK_SECRET: "whsec_ready",
  VERCEL_ENV: "production",
  RESEND_API_KEY: "re_live",
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

describe("adminSecondFactorExposures (T3)", () => {
  it("signale le paiement ouvert et l'envoi de l'agent quand le second facteur n'est pas exigé", () => {
    expect(
      adminSecondFactorExposures({ ...PAYMENT_OPEN, INFORMATION_AGENT_OUTBOUND_ENABLED: "true" }),
    ).toEqual(["payment", "information_agent_outbound"]);
    expect(adminSecondFactorExposures(PAYMENT_OPEN)).toEqual(["payment"]);
    expect(adminSecondFactorExposures({ INFORMATION_AGENT_OUTBOUND_ENABLED: "true" })).toEqual([
      "information_agent_outbound",
    ]);
  });

  it("ne dit rien quand le second facteur est exigé", () => {
    expect(
      adminSecondFactorExposures({
        ...PAYMENT_OPEN,
        INFORMATION_AGENT_OUTBOUND_ENABLED: "true",
        ADMIN_MFA_REQUIRED: "true",
      }),
    ).toEqual([]);
  });

  it("ne dit rien quand ni le paiement ni l'envoi ne sont ouverts", () => {
    expect(adminSecondFactorExposures({})).toEqual([]);
    // La vente fermée par l'interrupteur ferme aussi le paiement.
    expect(
      adminSecondFactorExposures({ ...PAYMENT_OPEN, STRIPE_ANALYSIS_SALES_OPEN: "false" }),
    ).toEqual([]);
    // Comme l'agent, seule la valeur exacte « true » ouvre l'envoi.
    for (const value of ["TRUE", "1", "yes", ""]) {
      expect(adminSecondFactorExposures({ INFORMATION_AGENT_OUTBOUND_ENABLED: value })).toEqual([]);
    }
  });
});
