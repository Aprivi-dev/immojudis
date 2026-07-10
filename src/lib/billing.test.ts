import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import {
  ANALYSIS_ACCESS_DAYS,
  ANALYSIS_PRICE_CENTS,
  buildAnalysisCheckoutSessionParams,
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
    expect(resolveCheckoutPlanCode("investisseur")).toBe("analyse");
    expect(resolveCheckoutPlanCode("analyse")).toBe("analyse");
    expect(resolveCheckoutPlanCode("decouverte")).toBe("analyse");
    expect(resolveCheckoutPlanCode("unknown")).toBe("analyse");
  });

  it("resolves Stripe plan codes from metadata before falling back to price ids", () => {
    expect(
      resolveStripePlanCode({
        metadataPlanCode: "investisseur",
        priceId: "price_legacy",
      }),
    ).toBe("analyse");
    expect(resolveStripePlanCode({ metadataPlanCode: null, priceId: null })).toBe("analyse");
  });

  it("defines the commercial offer as 29 EUR for exactly 30 days", () => {
    expect(ANALYSIS_PRICE_CENTS).toBe(2_900);
    expect(ANALYSIS_ACCESS_DAYS).toBe(30);
  });

  it("builds a one-time checkout without recurring subscription data", () => {
    const params = buildAnalysisCheckoutSessionParams({
      appOrigin: "https://immojudis.test",
      customerId: "cus_test",
      userId: "11111111-1111-4111-8111-111111111111",
    });

    expect(params).toMatchObject({
      mode: "payment",
      customer: "cus_test",
      client_reference_id: "11111111-1111-4111-8111-111111111111",
      line_items: [
        {
          price_data: {
            currency: "eur",
            unit_amount: 2_900,
          },
          quantity: 1,
        },
      ],
      metadata: {
        access_duration_days: "30",
        billing_model: "one_time_30_days",
        plan_code: "analyse",
      },
    });
    expect(params).not.toHaveProperty("subscription_data");
  });
});
