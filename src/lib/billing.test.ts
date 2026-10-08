import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import {
  ANALYSIS_ACCESS_DAYS,
  ANALYSIS_CHECKOUT_EXPIRY_MINUTES,
  ANALYSIS_OFFER_CODE,
  ANALYSIS_SUBSCRIPTION_BILLING_MODEL,
  ANALYSIS_SUBSCRIPTION_OFFER_CODE,
  ANALYSIS_PRICE_CENTS,
  ANALYSIS_TRIAL_DAYS,
  buildAnalysisCheckoutSessionParams,
  canReleaseCheckoutReservationAfterFailure,
  resolveBillingOrigin,
  resolveCheckoutPlanCode,
  resolveStripePlanCode,
  stripeDisputeStatusToPaymentState,
  stripeDisputeStatusToPlanStatus,
  stripeRefundRequiresAccessRevocation,
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
    const keys = [
      "SITE_URL",
      "NEXT_PUBLIC_APP_URL",
      "APP_URL",
      "NEXT_PUBLIC_SITE_URL",
      "VERCEL_URL",
    ] as const;
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

  it("keeps the historical one-time constants for webhook compatibility", () => {
    expect(ANALYSIS_PRICE_CENTS).toBe(2_900);
    expect(ANALYSIS_ACCESS_DAYS).toBe(30);
  });

  it("revokes one-time access only after a full refund", () => {
    expect(stripeRefundRequiresAccessRevocation(2_900, 1_000)).toBe(false);
    expect(stripeRefundRequiresAccessRevocation(2_900, 2_900)).toBe(true);
  });

  it("pauses disputed access and restores only a still-valid won dispute", () => {
    const now = new Date("2026-07-14T12:00:00.000Z");
    expect(stripeDisputeStatusToPlanStatus("under_review", "2026-08-01T00:00:00.000Z", now)).toBe(
      "paused",
    );
    expect(stripeDisputeStatusToPlanStatus("lost", "2026-08-01T00:00:00.000Z", now)).toBe(
      "cancelled",
    );
    expect(stripeDisputeStatusToPlanStatus("won", "2026-08-01T00:00:00.000Z", now)).toBe("active");
    expect(stripeDisputeStatusToPlanStatus("won", "2026-07-01T00:00:00.000Z", now)).toBe("expired");
    expect(stripeDisputeStatusToPaymentState("under_review")).toBe("disputed");
    expect(stripeDisputeStatusToPaymentState("lost")).toBe("dispute_lost");
    expect(stripeDisputeStatusToPaymentState("won")).toBe("cleared");
  });

  it("builds a recurring checkout with a card-backed seven-day trial", () => {
    const params = buildAnalysisCheckoutSessionParams({
      appOrigin: "https://immojudis.test",
      acceptanceId: "22222222-2222-4222-8222-222222222222",
      customerId: "cus_test",
      userId: "11111111-1111-4111-8111-111111111111",
      priceId: "price_test_analysis",
    });

    expect(params).toMatchObject({
      mode: "subscription",
      customer: "cus_test",
      client_reference_id: "11111111-1111-4111-8111-111111111111",
      line_items: [
        {
          price: "price_test_analysis",
          quantity: 1,
        },
      ],
      metadata: {
        commercial_acceptance_id: "22222222-2222-4222-8222-222222222222",
        trial_days: String(ANALYSIS_TRIAL_DAYS),
        billing_model: "subscription_trial_7_days",
        plan_code: "analyse",
      },
      payment_method_collection: "always",
      subscription_data: {
        trial_period_days: ANALYSIS_TRIAL_DAYS,
      },
    });
    expect(params).not.toHaveProperty("payment_intent_data");
  });

  it("builds a paid recurring checkout without replaying a consumed trial", () => {
    const params = buildAnalysisCheckoutSessionParams({
      appOrigin: "https://immojudis.test",
      customerId: "cus_returning",
      userId: "11111111-1111-4111-8111-111111111111",
      priceId: "price_test_analysis",
      trialDays: 0,
      offerCode: ANALYSIS_SUBSCRIPTION_OFFER_CODE,
      billingModel: ANALYSIS_SUBSCRIPTION_BILLING_MODEL,
      expiresAt: 1_800_000_000,
    });

    expect(params).toMatchObject({
      mode: "subscription",
      payment_method_collection: "always",
      expires_at: 1_800_000_000,
      metadata: {
        offer_code: ANALYSIS_SUBSCRIPTION_OFFER_CODE,
        billing_model: ANALYSIS_SUBSCRIPTION_BILLING_MODEL,
        trial_days: "0",
      },
      subscription_data: {
        metadata: {
          offer_code: ANALYSIS_SUBSCRIPTION_OFFER_CODE,
          billing_model: ANALYSIS_SUBSCRIPTION_BILLING_MODEL,
          trial_days: "0",
        },
      },
    });
    expect(params.subscription_data).not.toHaveProperty("trial_period_days");
    expect(ANALYSIS_CHECKOUT_EXPIRY_MINUTES).toBeGreaterThanOrEqual(30);
    expect(ANALYSIS_OFFER_CODE).toBe("analyse_subscription_trial_7_days");
  });

  it("keeps a reservation when Stripe could not expire the open checkout", () => {
    expect(canReleaseCheckoutReservationAfterFailure("open", false)).toBe(false);
    expect(canReleaseCheckoutReservationAfterFailure("open", true)).toBe(true);
    expect(canReleaseCheckoutReservationAfterFailure("expired", false)).toBe(true);
    expect(canReleaseCheckoutReservationAfterFailure(undefined, false)).toBe(true);
  });
});
