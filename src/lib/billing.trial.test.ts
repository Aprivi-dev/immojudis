import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  retrievePaymentMethod: vi.fn(),
  updateSubscription: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock("stripe", () => ({
  default: class {
    paymentMethods = { retrieve: mocks.retrievePaymentMethod };
    subscriptions = { update: mocks.updateSubscription };
    customers = { retrieve: vi.fn() };
  },
}));

import type Stripe from "stripe";
import { buildAnalysisCheckoutSessionParams, enforceSingleTrialPerCard } from "@/lib/billing";

const subscription = (overrides: Partial<Stripe.Subscription> = {}) =>
  ({
    id: "sub_1",
    status: "trialing",
    customer: "cus_1",
    default_payment_method: "pm_1",
    ...overrides,
  }) as Stripe.Subscription;

describe("un essai par carte", () => {
  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
    mocks.rpc.mockReset();
    mocks.retrievePaymentMethod.mockReset();
    mocks.updateSubscription.mockReset();
    mocks.retrievePaymentMethod.mockResolvedValue({ card: { fingerprint: "fp_abc" } });
  });

  it("laisse l'essai courir quand la carte est nouvelle", async () => {
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    await expect(enforceSingleTrialPerCard(subscription(), "user-1")).resolves.toBe("claimed");
    expect(mocks.updateSubscription).not.toHaveBeenCalled();
    const args = mocks.rpc.mock.calls[0][1];
    expect(args.p_user_id).toBe("user-1");
    // Only a hash of the fingerprint leaves the Stripe call.
    expect(args.p_fingerprint_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(args)).not.toContain("fp_abc");
  });

  it("met fin à l'essai quand la carte a déjà servi pour un autre compte", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    await expect(enforceSingleTrialPerCard(subscription(), "user-2")).resolves.toBe("reused");
    expect(mocks.updateSubscription).toHaveBeenCalledWith("sub_1", { trial_end: "now" });
  });

  it("ne fait rien hors essai ou sans empreinte de carte", async () => {
    await expect(
      enforceSingleTrialPerCard(subscription({ status: "active" }), "user-1"),
    ).resolves.toBe("unknown");
    mocks.retrievePaymentMethod.mockResolvedValue({ card: null });
    await expect(enforceSingleTrialPerCard(subscription(), "user-1")).resolves.toBe("unknown");
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.updateSubscription).not.toHaveBeenCalled();
  });
});

describe("checkout professionnel", () => {
  it("collecte l'adresse de facturation et le numéro de TVA", () => {
    vi.stubEnv("STRIPE_PRICE_ID_ANALYSE", "price_1");
    const params = buildAnalysisCheckoutSessionParams({
      appOrigin: "https://immojudis.test",
      customerId: "cus_1",
      userId: "user-1",
      priceId: "price_1",
    });
    expect(params.billing_address_collection).toBe("required");
    expect(params.tax_id_collection).toEqual({ enabled: true });
    expect(params.customer_update).toEqual({ name: "auto", address: "auto" });
  });
});
