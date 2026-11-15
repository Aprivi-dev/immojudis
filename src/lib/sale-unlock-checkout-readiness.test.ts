import { describe, expect, it } from "vitest";
import { PublicApiError } from "@/lib/api-errors";
import {
  assertSaleUnlockCheckoutOpen,
  saleUnlockCheckoutReadiness,
  saleUnlockPriceId,
} from "@/lib/sale-unlock-checkout-readiness";

const PAYMENTS_ENV = {
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

const OPEN_ENV = {
  ...PAYMENTS_ENV,
  STRIPE_SALE_UNLOCK_PRICE_ID: "price_1UnitTest",
  STRIPE_SALE_UNLOCK_SALES_OPEN: "true",
};

describe("saleUnlockCheckoutReadiness", () => {
  it("est ouvert quand les paiements, le Price et l'interrupteur le sont", () => {
    expect(saleUnlockCheckoutReadiness(OPEN_ENV)).toEqual({
      open: true,
      missing: [],
      keyModeMismatch: false,
      salesClosed: false,
    });
    expect(() => assertSaleUnlockCheckoutOpen(OPEN_ENV)).not.toThrow();
  });

  it("est fermé par défaut : interrupteur absent ou vide (l'inverse de STRIPE_ANALYSIS_SALES_OPEN)", () => {
    const { STRIPE_SALE_UNLOCK_SALES_OPEN: _omitted, ...withoutSwitch } = OPEN_ENV;
    expect(saleUnlockCheckoutReadiness(withoutSwitch)).toMatchObject({
      open: false,
      salesClosed: true,
    });
    expect(
      saleUnlockCheckoutReadiness({ ...OPEN_ENV, STRIPE_SALE_UNLOCK_SALES_OPEN: " " }).open,
    ).toBe(false);
  });

  it.each(["false", "0", "oui", "1", "ture"])("reste fermé pour la valeur « %s »", (value) => {
    expect(
      saleUnlockCheckoutReadiness({ ...OPEN_ENV, STRIPE_SALE_UNLOCK_SALES_OPEN: value }).open,
    ).toBe(false);
  });

  it("lit l'interrupteur comme celui d'Analyse : `true`, espaces et casse indifférents", () => {
    expect(
      saleUnlockCheckoutReadiness({ ...OPEN_ENV, STRIPE_SALE_UNLOCK_SALES_OPEN: " TRUE " }).open,
    ).toBe(true);
  });

  it("est fermé sans Price, ou avec un Price mal formé, même interrupteur ouvert", () => {
    const { STRIPE_SALE_UNLOCK_PRICE_ID: _omitted, ...withoutPrice } = OPEN_ENV;
    expect(saleUnlockCheckoutReadiness(withoutPrice)).toMatchObject({
      open: false,
      missing: ["STRIPE_SALE_UNLOCK_PRICE_ID"],
    });
    expect(saleUnlockPriceId({ STRIPE_SALE_UNLOCK_PRICE_ID: "prod_123" })).toBeUndefined();
    expect(saleUnlockPriceId({ STRIPE_SALE_UNLOCK_PRICE_ID: " price_1UnitTest " })).toBe(
      "price_1UnitTest",
    );
  });

  it("reprend ce qui manque aux paiements Analyse et la divergence de mode de la clé", () => {
    const { STRIPE_WEBHOOK_SECRET: _omitted, ...withoutWebhook } = OPEN_ENV;
    expect(saleUnlockCheckoutReadiness(withoutWebhook)).toMatchObject({
      open: false,
      missing: ["STRIPE_WEBHOOK_SECRET"],
    });
    expect(
      saleUnlockCheckoutReadiness({ ...OPEN_ENV, VERCEL_ENV: "production" }),
    ).toMatchObject({ open: false, keyModeMismatch: true });
  });

  it("ne dépend pas de l'interrupteur de vente d'Analyse", () => {
    expect(
      saleUnlockCheckoutReadiness({ ...OPEN_ENV, STRIPE_ANALYSIS_SALES_OPEN: "false" }).open,
    ).toBe(true);
  });

  it("garde fermée : 503 avec un message pour le client", () => {
    const { STRIPE_SALE_UNLOCK_SALES_OPEN: _omitted, ...closed } = OPEN_ENV;
    expect(() => assertSaleUnlockCheckoutOpen(closed)).toThrow(PublicApiError);
    expect(() => assertSaleUnlockCheckoutOpen(closed)).toThrow(/n’est pas ouvert/);
    try {
      assertSaleUnlockCheckoutOpen(closed);
    } catch (error) {
      expect((error as PublicApiError).status).toBe(503);
    }
  });
});
