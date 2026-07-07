import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import {
  resolveBillingOrigin,
  resolveCheckoutPlanCode,
  resolveStripePlanCode,
  stripeCurrentPeriodEndIso,
  stripeSubscriptionStatusToPlanStatus,
} from "@/lib/billing";

describe("billing helpers", () => {
  it("maps Stripe subscription states to ImmoJudis plan states", () => {
    expect(stripeSubscriptionStatusToPlanStatus("trialing")).toBe("trialing");
    expect(stripeSubscriptionStatusToPlanStatus("active")).toBe("active");
    expect(stripeSubscriptionStatusToPlanStatus("incomplete")).toBe("past_due");
    expect(stripeSubscriptionStatusToPlanStatus("unpaid")).toBe("past_due");
    expect(stripeSubscriptionStatusToPlanStatus("canceled")).toBe("cancelled");
    expect(stripeSubscriptionStatusToPlanStatus("incomplete_expired")).toBe("expired");
  });

  it("reads the period end from the current subscription item", () => {
    const subscription = {
      ended_at: null,
      trial_end: 1_780_000_000,
      items: {
        data: [{ current_period_end: 1_800_000_000 }],
      },
    } as Stripe.Subscription;

    expect(stripeCurrentPeriodEndIso(subscription)).toBe("2027-01-15T08:00:00.000Z");
  });

  it("normalizes configured billing origins", () => {
    const keys = ["NEXT_PUBLIC_APP_URL", "APP_URL", "NEXT_PUBLIC_SITE_URL", "VERCEL_URL"] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

    try {
      keys.forEach((key) => delete process.env[key]);
      expect(resolveBillingOrigin("http://localhost:3000/")).toBe("http://localhost:3000");
    } finally {
      keys.forEach((key) => {
        if (previous[key] == null) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      });
    }
  });

  it("normalizes checkout plan codes with Analyse as the safe paid default", () => {
    expect(resolveCheckoutPlanCode("investisseur")).toBe("investisseur");
    expect(resolveCheckoutPlanCode("analyse")).toBe("analyse");
    expect(resolveCheckoutPlanCode("decouverte")).toBe("analyse");
    expect(resolveCheckoutPlanCode("unknown")).toBe("analyse");
  });

  it("resolves Stripe plan codes from metadata before falling back to price ids", () => {
    const previous = process.env.STRIPE_INVESTISSEUR_PRICE_ID;
    process.env.STRIPE_INVESTISSEUR_PRICE_ID = "price_investisseur";

    try {
      expect(
        resolveStripePlanCode({
          metadataPlanCode: "investisseur",
          priceId: "price_analyse",
        }),
      ).toBe("investisseur");
      expect(
        resolveStripePlanCode({
          metadataPlanCode: null,
          priceId: "price_investisseur",
        }),
      ).toBe("investisseur");
      expect(
        resolveStripePlanCode({
          metadataPlanCode: null,
          priceId: "price_analyse",
        }),
      ).toBe("analyse");
    } finally {
      if (previous == null) {
        delete process.env.STRIPE_INVESTISSEUR_PRICE_ID;
      } else {
        process.env.STRIPE_INVESTISSEUR_PRICE_ID = previous;
      }
    }
  });
});
