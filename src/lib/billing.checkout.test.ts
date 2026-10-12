import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { CheckoutConsent } from "@/lib/commercial-acceptance";

const mocks = vi.hoisted(() => ({
  adminRpc: vi.fn(),
  checkoutCreate: vi.fn(),
  customersCreate: vi.fn(),
  pricesRetrieve: vi.fn(),
  subscriptionsList: vi.fn(),
  events: [] as string[],
}));

vi.mock("stripe", () => ({
  default: class FakeStripe {
    customers = { create: mocks.customersCreate };
    prices = { retrieve: mocks.pricesRetrieve };
    subscriptions = { list: mocks.subscriptionsList };
    checkout = {
      sessions: {
        create: mocks.checkoutCreate,
        expire: vi.fn(),
      },
    };
  },
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.adminRpc },
}));
vi.mock("@/lib/legal-documents", () => ({
  assertPaidOfferLegalReadiness: vi.fn(),
}));
vi.mock("@/lib/commercial-acceptance", () => ({
  assertCommercialConfirmationReadiness: vi.fn(),
  recordCommercialAcceptance: vi.fn().mockResolvedValue(undefined),
  sendCommercialConfirmation: vi.fn(),
}));

import { createPlanCheckoutSession, stripeCustomerIdempotencyKey } from "@/lib/billing";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_ID = "cus_shared";
const consent = {
  termsAccepted: true,
  termsVersion: "2026-10-03.1",
  privacyVersion: "2026-09-19.1",
  paymentObligationAcknowledged: true,
  immediatePerformanceRequested: true,
  withdrawalInformationAcknowledged: true,
} satisfies CheckoutConsent;

describe("createPlanCheckoutSession customer reservation", () => {
  let previousStripeSecret: string | undefined;
  let previousAnalysisPrice: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    previousStripeSecret = process.env.STRIPE_SECRET_KEY;
    previousAnalysisPrice = process.env.STRIPE_ANALYSIS_PRICE_ID;
    process.env.STRIPE_SECRET_KEY = "sk_test_billing";
    process.env.STRIPE_ANALYSIS_PRICE_ID = "price_analysis";
    mocks.pricesRetrieve.mockResolvedValue({
      active: true,
      type: "recurring",
      currency: "eur",
      unit_amount: 2_900,
      recurring: { interval: "month", interval_count: 1 },
    });
    mocks.subscriptionsList.mockResolvedValue({ data: [], has_more: false });
    mocks.checkoutCreate.mockResolvedValue({
      id: "cs_analysis",
      url: "https://checkout.stripe.test/cs_analysis",
      created: 1_800_000_000,
      status: "open",
    });
    mocks.adminRpc.mockImplementation(async (name: string, args: Record<string, string>) => {
      if (name === "reserve_analyse_checkout") {
        const callNumber = mocks.events.filter((event) => event.startsWith("reserve:")).length + 1;
        mocks.events.push(`reserve:${args.p_checkout_token}`);
        return { data: callNumber === 1, error: null };
      }
      if (name === "attach_analyse_checkout_customer") {
        mocks.events.push(`attach:${args.p_checkout_token}`);
        return { data: CUSTOMER_ID, error: null };
      }
      if (name === "release_analyse_checkout") return { data: true, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    });
  });

  afterEach(() => {
    if (previousStripeSecret == null) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousStripeSecret;
    if (previousAnalysisPrice == null) delete process.env.STRIPE_ANALYSIS_PRICE_ID;
    else process.env.STRIPE_ANALYSIS_PRICE_ID = previousAnalysisPrice;
  });

  it("réserve avant le premier Customer et refuse la seconde demande concurrente", async () => {
    let releaseCustomer!: () => void;
    const customerCreated = new Promise<void>((resolve) => {
      releaseCustomer = resolve;
    });
    mocks.customersCreate.mockImplementation(async () => {
      mocks.events.push("customer:create");
      await customerCreated;
      return { id: CUSTOMER_ID };
    });

    const auth = buildAuthContext();
    const first = createPlanCheckoutSession({
      auth,
      origin: "https://immojudis.test",
      plan: "analyse",
      consent,
    });
    await vi.waitFor(() => expect(mocks.customersCreate).toHaveBeenCalledTimes(1));

    const second = createPlanCheckoutSession({
      auth,
      origin: "https://immojudis.test",
      plan: "analyse",
      consent,
    });
    await expect(second).rejects.toThrow(/déjà associé/i);

    expect(mocks.customersCreate).toHaveBeenCalledTimes(1);
    expect(mocks.customersCreate.mock.calls[0]?.[1]).toEqual({
      idempotencyKey: stripeCustomerIdempotencyKey(USER_ID),
    });
    expect(mocks.events[0]).toMatch(/^reserve:/);
    expect(mocks.events.indexOf("customer:create")).toBeGreaterThan(0);

    releaseCustomer();
    await expect(first).resolves.toEqual({ url: "https://checkout.stripe.test/cs_analysis" });

    expect(mocks.adminRpc).toHaveBeenCalledWith(
      "attach_analyse_checkout_customer",
      expect.objectContaining({
        p_checkout_token: expect.stringMatching(/^[0-9a-f-]{36}$/),
        p_stripe_customer_id: CUSTOMER_ID,
        p_user_id: USER_ID,
      }),
    );
  });

  it("refuse un Price Stripe qui ne correspond pas aux 29 EUR mensuels validés", async () => {
    mocks.pricesRetrieve.mockResolvedValue({
      active: true,
      type: "recurring",
      currency: "eur",
      unit_amount: 3_000,
      recurring: { interval: "year", interval_count: 1 },
    });

    await expect(
      createPlanCheckoutSession({
        auth: buildAuthContext(),
        origin: "https://immojudis.test",
        plan: "analyse",
        consent,
      }),
    ).rejects.toThrow(/29 € \/ mois/);
    expect(mocks.adminRpc).not.toHaveBeenCalled();
  });
});

function buildAuthContext(): SupabaseAuthContext {
  const row = {
    user_id: USER_ID,
    plan_code: "decouverte",
    status: "active",
    stripe_customer_id: null,
    stripe_subscription_id: null,
    current_period_end: null,
    metadata: {},
  };
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
  };
  return {
    supabase: { from: vi.fn().mockReturnValue(query) } as never,
    userId: USER_ID,
    claims: { sub: USER_ID, email: "buyer@example.test" },
    accountTier: "free",
    userRole: "user",
    isAdmin: false,
  };
}
