import { describe, expect, it } from "vitest";
import {
  analysisCheckoutReadiness,
  analysisPriceId,
  assertAnalysisCheckoutOpen,
  stripeKeyMode,
} from "@/lib/analysis-checkout-readiness";
import { ANALYSIS_RECURRING_PRICE_CENTS } from "@/lib/analysis-offer";
import { PublicApiError } from "@/lib/api-errors";
import { analysisSubscriptionPriceIds, isRecognisedAnalysisPrice } from "@/lib/billing";
import { billingReconciliationConfigured } from "@/lib/billing-reconciliation";

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
    expect(analysisCheckoutReadiness(COMPLETE_ENV)).toEqual({
      open: true,
      missing: [],
      keyModeMismatch: false,
      salesClosed: false,
    });
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

describe("analysisPriceId", () => {
  it("rend le Price s'il a la forme d'un Price Stripe, sans les espaces autour", () => {
    expect(analysisPriceId({ STRIPE_ANALYSIS_PRICE_ID: " price_1AnalysisTest " })).toBe(
      "price_1AnalysisTest",
    );
  });

  it("ne rend rien pour un Price absent, vide ou mal formé", () => {
    for (const value of [undefined, "", "  ", "prod_1Analysis", "price_with-dash"]) {
      expect(analysisPriceId({ STRIPE_ANALYSIS_PRICE_ID: value }), String(value)).toBeUndefined();
    }
  });
});

describe("interrupteur de vente STRIPE_ANALYSIS_SALES_OPEN (C2)", () => {
  /** Configuration réelle d'un déploiement de production, vente ouverte. */
  const LIVE_ENV = {
    ...COMPLETE_ENV,
    STRIPE_SECRET_KEY: "sk_live_ready",
    VERCEL_ENV: "production",
  };

  it("absente ou vide, laisse la vente ouverte : le déploiement ne ferme pas la production", () => {
    expect(analysisCheckoutReadiness(LIVE_ENV).open).toBe(true);
    for (const value of ["", "  ", "true", "TRUE", " true "]) {
      expect(
        analysisCheckoutReadiness({ ...LIVE_ENV, STRIPE_ANALYSIS_SALES_OPEN: value }).open,
        JSON.stringify(value),
      ).toBe(true);
    }
  });

  it("posée à autre chose que true, ferme le checkout même si la configuration est complète", () => {
    for (const value of ["false", "FALSE", "0", "non", "off", "fasle"]) {
      const readiness = analysisCheckoutReadiness({
        ...LIVE_ENV,
        STRIPE_ANALYSIS_SALES_OPEN: value,
      });
      expect(readiness, value).toEqual({
        open: false,
        missing: [],
        keyModeMismatch: false,
        salesClosed: true,
      });
    }
    let refusal: unknown;
    try {
      assertAnalysisCheckoutOpen({ ...LIVE_ENV, STRIPE_ANALYSIS_SALES_OPEN: "false" });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(PublicApiError);
    expect(refusal).toMatchObject({ status: 503 });
  });

  it("vente fermée : le Price reste reconnu et le rapprochement reste actif", () => {
    const closed = { ...LIVE_ENV, STRIPE_ANALYSIS_SALES_OPEN: "false" };

    expect(analysisCheckoutReadiness(closed).open).toBe(false);
    // Un abonné prélevé sur ce Price garde son accès (pas de passage en « decouverte »)...
    expect(analysisSubscriptionPriceIds(closed)).toEqual(["price_1AnalysisTest"]);
    expect(
      isRecognisedAnalysisPrice(
        { id: "price_1AnalysisTest", unit_amount: ANALYSIS_RECURRING_PRICE_CENTS },
        closed,
      ),
    ).toBe(true);
    // ... et le rapprochement quotidien avec Stripe continue de tourner.
    expect(billingReconciliationConfigured(closed)).toBe(true);
  });
});

describe("mode de la clé Stripe et du déploiement (C3)", () => {
  it("lit le mode d'une clé secrète ou restreinte d'après son préfixe", () => {
    expect(stripeKeyMode("sk_live_abc")).toBe("live");
    expect(stripeKeyMode(" rk_live_abc ")).toBe("live");
    expect(stripeKeyMode("sk_test_abc")).toBe("test");
    expect(stripeKeyMode("rk_test_abc")).toBe("test");
    for (const key of [undefined, null, "", "pk_live_abc", "stripe-secret-test", "sk_abc"]) {
      expect(stripeKeyMode(key), String(key)).toBeNull();
    }
  });

  it("ferme la garde avec une clé de test en production", () => {
    const readiness = analysisCheckoutReadiness({ ...COMPLETE_ENV, VERCEL_ENV: "production" });
    expect(readiness).toMatchObject({ open: false, missing: [], keyModeMismatch: true });
    expect(() => assertAnalysisCheckoutOpen({ ...COMPLETE_ENV, VERCEL_ENV: "production" })).toThrow(
      /STRIPE_SECRET_KEY \(mode de la clé inconnu ou différent.*checkout est suspendu/,
    );
  });

  it("exige le mode réel en production : une clé dont le mode ne se lit pas ferme la garde", () => {
    for (const STRIPE_SECRET_KEY of ["stripe-secret", "sk_abc", "pk_live_abc", "live_abc"]) {
      expect(
        analysisCheckoutReadiness({ ...COMPLETE_ENV, STRIPE_SECRET_KEY, VERCEL_ENV: "production" }),
        STRIPE_SECRET_KEY,
      ).toMatchObject({ open: false, missing: [], keyModeMismatch: true });
    }
    // Sur un preview aussi : seule une clé de test l'ouvre.
    expect(
      analysisCheckoutReadiness({
        ...COMPLETE_ENV,
        STRIPE_SECRET_KEY: "stripe-secret",
        VERCEL_ENV: "preview",
      }).open,
    ).toBe(false);
    // Clé absente : elle manque, ce n'est pas une question de mode.
    expect(
      analysisCheckoutReadiness({
        ...COMPLETE_ENV,
        STRIPE_SECRET_KEY: "",
        VERCEL_ENV: "production",
      }),
    ).toMatchObject({ missing: ["STRIPE_SECRET_KEY"], keyModeMismatch: false });
  });

  it("ferme la garde avec une clé réelle sur un preview ou en développement", () => {
    for (const VERCEL_ENV of ["preview", "development"]) {
      expect(
        analysisCheckoutReadiness({ ...COMPLETE_ENV, STRIPE_SECRET_KEY: "sk_live_x", VERCEL_ENV }),
        VERCEL_ENV,
      ).toMatchObject({ open: false, keyModeMismatch: true });
    }
  });

  it("reste ouverte quand les modes concordent, ou hors Vercel où rien n'est à comparer", () => {
    expect(
      analysisCheckoutReadiness({
        ...COMPLETE_ENV,
        STRIPE_SECRET_KEY: "sk_live_x",
        VERCEL_ENV: "production",
      }).open,
    ).toBe(true);
    expect(analysisCheckoutReadiness({ ...COMPLETE_ENV, VERCEL_ENV: "preview" }).open).toBe(true);
    expect(
      analysisCheckoutReadiness({ ...COMPLETE_ENV, STRIPE_SECRET_KEY: "sk_live_x" }).open,
    ).toBe(true);
  });
});
