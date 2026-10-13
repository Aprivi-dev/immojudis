import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";

const mocks = vi.hoisted(() => ({
  portalCreate: vi.fn(),
  maybeSingle: vi.fn(),
  eq: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: class FakeStripe {
    billingPortal = { sessions: { create: mocks.portalCreate } };
  },
}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import {
  billingPortalCancelReturnUrl,
  buildBillingPortalSessionParams,
  createBillingPortalSession,
} from "@/lib/billing";

const USER_ID = "11111111-1111-4111-8111-111111111111";

function authContext(): SupabaseAuthContext {
  mocks.eq.mockReturnValue({ maybeSingle: mocks.maybeSingle });
  return {
    userId: USER_ID,
    supabase: { from: () => ({ select: () => ({ eq: mocks.eq }) }) },
  } as unknown as SupabaseAuthContext;
}

describe("buildBillingPortalSessionParams", () => {
  it("builds the generic portal session without any flow", () => {
    expect(
      buildBillingPortalSessionParams({
        appOrigin: "https://immojudis.test",
        customerId: "cus_1",
      }),
    ).toEqual({
      customer: "cus_1",
      return_url: "https://immojudis.test/offres?billing=portal",
      locale: "fr",
    });
  });

  it("opens the cancellation flow of the given subscription and comes back to /compte", () => {
    const params = buildBillingPortalSessionParams({
      appOrigin: "https://immojudis.test",
      customerId: "cus_1",
      cancelSubscriptionId: "sub_1",
    });
    expect(params.flow_data).toEqual({
      type: "subscription_cancel",
      subscription_cancel: { subscription: "sub_1" },
      after_completion: {
        type: "redirect",
        redirect: { return_url: "https://immojudis.test/compte" },
      },
    });
    expect(billingPortalCancelReturnUrl("https://immojudis.test")).toBe(
      "https://immojudis.test/compte",
    );
  });
});

describe("createBillingPortalSession", () => {
  let previousStripeSecret: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    previousStripeSecret = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = "sk_test_portal";
    mocks.portalCreate.mockResolvedValue({ url: "https://billing.stripe.test/session" });
  });

  afterEach(() => {
    if (previousStripeSecret == null) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousStripeSecret;
  });

  it("keeps the generic portal by default, even when a subscription exists", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", status: "active" },
      error: null,
    });

    await expect(
      createBillingPortalSession({ auth: authContext(), origin: "https://immojudis.test" }),
    ).resolves.toEqual({ url: "https://billing.stripe.test/session" });

    const params = mocks.portalCreate.mock.calls[0]?.[0];
    expect(params).toMatchObject({ customer: "cus_1" });
    expect(params).not.toHaveProperty("flow_data");
  });

  it.each(["trialing", "active", "past_due"])(
    "opens the cancellation flow with the subscription of the user's own row (%s)",
    async (status) => {
      mocks.maybeSingle.mockResolvedValue({
        data: { stripe_customer_id: "cus_1", stripe_subscription_id: "sub_own", status },
        error: null,
      });

      await createBillingPortalSession({
        auth: authContext(),
        origin: "https://immojudis.test",
        intent: "cancel",
      });

      expect(mocks.eq).toHaveBeenCalledWith("user_id", USER_ID);
      expect(mocks.portalCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: "cus_1",
          flow_data: expect.objectContaining({
            type: "subscription_cancel",
            subscription_cancel: { subscription: "sub_own" },
          }),
        }),
      );
    },
  );

  it.each([
    ["no Stripe subscription yet", { stripe_subscription_id: null, status: "active" }],
    ["a cancelled subscription", { stripe_subscription_id: "sub_old", status: "cancelled" }],
    ["a paused subscription", { stripe_subscription_id: "sub_old", status: "paused" }],
  ])("refuses to cancel with %s", async (_label, row) => {
    mocks.maybeSingle.mockResolvedValue({
      data: { stripe_customer_id: "cus_1", ...row },
      error: null,
    });

    await expect(
      createBillingPortalSession({
        auth: authContext(),
        origin: "https://immojudis.test",
        intent: "cancel",
      }),
    ).rejects.toThrow("Aucun abonnement Analyse à résilier");
    expect(mocks.portalCreate).not.toHaveBeenCalled();
  });

  it("refuses any portal session without a Stripe customer", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });

    await expect(
      createBillingPortalSession({ auth: authContext(), intent: "cancel" }),
    ).rejects.toThrow("Aucun compte Stripe");
    expect(mocks.portalCreate).not.toHaveBeenCalled();
  });
});
