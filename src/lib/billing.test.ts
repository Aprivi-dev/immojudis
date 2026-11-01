import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { isPlanPeriodActive } from "@/lib/plans";
import {
  ANALYSIS_ACCESS_DAYS,
  ANALYSIS_CHECKOUT_EXPIRY_MINUTES,
  ANALYSIS_OFFER_CODE,
  ANALYSIS_SUBSCRIPTION_BILLING_MODEL,
  ANALYSIS_SUBSCRIPTION_OFFER_CODE,
  ANALYSIS_PRICE_CENTS,
  ANALYSIS_TRIAL_DAYS,
  billingPortalReturnUrl,
  buildAnalysisCheckoutSessionParams,
  canReleaseCheckoutReservationAfterFailure,
  isAnalysisSubscriptionPrice,
  isRecognisedAnalysisPrice,
  resolveBillingOrigin,
  resolveCheckoutPlanCode,
  resolveStripePlanCode,
  stripeDisputeIsCleared,
  stripeDisputeStatusToPaymentState,
  stripeDisputeStatusToPlanStatus,
  stripeRefundRequiresAccessRevocation,
  stripeAccessPeriodEndIso,
  stripeCurrentPeriodEndIso,
  stripeSubscriptionStatusToPlanStatus,
} from "@/lib/billing";

describe("billing helpers", () => {
  it("maps Stripe subscription states to ImmoJudis plan states", () => {
    expect(stripeSubscriptionStatusToPlanStatus("trialing")).toBe("trialing");
    expect(stripeSubscriptionStatusToPlanStatus("active")).toBe("active");
    expect(stripeSubscriptionStatusToPlanStatus("past_due")).toBe("past_due");
    expect(stripeSubscriptionStatusToPlanStatus("paused")).toBe("paused");
    expect(stripeSubscriptionStatusToPlanStatus("canceled")).toBe("cancelled");
    expect(stripeSubscriptionStatusToPlanStatus("incomplete_expired")).toBe("expired");
  });

  it("never grants access for incomplete or unpaid Stripe subscriptions", () => {
    const now = new Date("2026-10-13T12:00:00.000Z");
    const periodEnd = "2026-11-13T12:00:00.000Z";
    for (const stripeStatus of ["incomplete", "unpaid"]) {
      const status = stripeSubscriptionStatusToPlanStatus(stripeStatus);
      expect(status).toBe("paused");
      expect(isPlanPeriodActive(status, periodEnd, now)).toBe(false);
    }
    // past_due, lui, garde la grâce de 7 jours.
    expect(isPlanPeriodActive("past_due", "2026-10-10T12:00:00.000Z", now)).toBe(true);
  });

  it("counts the past_due grace from the start of the unpaid period", () => {
    const subscription = {
      ended_at: null,
      trial_end: null,
      items: {
        data: [{ current_period_start: 1_800_000_000, current_period_end: 1_802_592_000 }],
      },
    } as Stripe.Subscription;

    expect(stripeAccessPeriodEndIso(subscription, "past_due")).toBe("2027-01-15T08:00:00.000Z");
    expect(stripeAccessPeriodEndIso(subscription, "active")).toBe("2027-02-14T08:00:00.000Z");
    expect(stripeAccessPeriodEndIso(subscription, "trialing")).toBe("2027-02-14T08:00:00.000Z");
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

  it("returns from the billing portal to the offers page", () => {
    expect(billingPortalReturnUrl("https://immojudis.test")).toBe(
      "https://immojudis.test/offres?billing=portal",
    );
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
    expect(ANALYSIS_PRICE_CENTS).toBe(5_900);
    expect(ANALYSIS_ACCESS_DAYS).toBe(30);
  });

  it("revokes one-time access only after a full refund", () => {
    expect(stripeRefundRequiresAccessRevocation(5_900, 1_000)).toBe(false);
    expect(stripeRefundRequiresAccessRevocation(5_900, 5_900)).toBe(true);
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
    // n° 46 : un litige qui n'a jamais abouti rend l'accès, il ne reste pas suspendu à vie.
    for (const cleared of ["warning_closed", "prevented"]) {
      expect(stripeDisputeIsCleared(cleared)).toBe(true);
      expect(stripeDisputeStatusToPlanStatus(cleared, "2026-08-01T00:00:00.000Z", now)).toBe(
        "active",
      );
      expect(stripeDisputeStatusToPaymentState(cleared)).toBe("cleared");
    }
    for (const open of [
      "needs_response",
      "under_review",
      "warning_needs_response",
      "warning_under_review",
    ]) {
      expect(stripeDisputeIsCleared(open)).toBe(false);
      expect(stripeDisputeStatusToPaymentState(open)).toBe("disputed");
    }
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

  it("recognises only the approved Analyse price once one is configured", () => {
    expect(
      isAnalysisSubscriptionPrice("price_other", { STRIPE_ANALYSIS_PRICE_ID: "price_ok" }),
    ).toBe(false);
    expect(isAnalysisSubscriptionPrice("price_ok", { STRIPE_ANALYSIS_PRICE_ID: "price_ok" })).toBe(
      true,
    );
    // Fermé par défaut (n° 47) : sans Price configuré, ou sans Price sur l'abonnement, rien n'est reconnu.
    expect(isAnalysisSubscriptionPrice("price_other", {})).toBe(false);
    expect(isAnalysisSubscriptionPrice(null, { STRIPE_ANALYSIS_PRICE_ID: "price_ok" })).toBe(false);
    expect(
      isAnalysisSubscriptionPrice("price_old", { STRIPE_ANALYSIS_LEGACY_PRICE_IDS: "price_old" }),
    ).toBe(true);
  });

  it("compares the current Price amount with 59 EUR, but trusts the declared legacy Prices", () => {
    const env = {
      STRIPE_ANALYSIS_PRICE_ID: "price_ok",
      STRIPE_ANALYSIS_LEGACY_PRICE_IDS: "price_old",
    };
    expect(isRecognisedAnalysisPrice({ id: "price_ok", unit_amount: 5_900 }, env)).toBe(true);
    expect(isRecognisedAnalysisPrice({ id: "price_ok", unit_amount: 3_000 }, env)).toBe(false);
    expect(isRecognisedAnalysisPrice({ id: "price_ok", unit_amount: null }, env)).toBe(false);
    expect(isRecognisedAnalysisPrice({ id: "price_old", unit_amount: 4_900 }, env)).toBe(true);
    expect(isRecognisedAnalysisPrice({ id: "price_other", unit_amount: 5_900 }, env)).toBe(false);
    expect(isRecognisedAnalysisPrice({ id: "price_ok", unit_amount: 5_900 }, {})).toBe(false);
    expect(isRecognisedAnalysisPrice(undefined, env)).toBe(false);
  });
});
