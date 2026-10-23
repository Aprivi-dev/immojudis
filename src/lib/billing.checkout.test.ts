import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { CheckoutConsent } from "@/lib/commercial-acceptance";

const mocks = vi.hoisted(() => ({
  adminRpc: vi.fn(),
  checkoutCreate: vi.fn(),
  customersCreate: vi.fn(),
  pricesRetrieve: vi.fn(),
  subscriptionsList: vi.fn(),
  sessionsList: vi.fn(),
  sessionsExpire: vi.fn(),
  assertOpen: vi.fn(),
  launchState: vi.fn(),
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
        expire: mocks.sessionsExpire,
        list: mocks.sessionsList,
      },
    };
  },
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.adminRpc },
}));
vi.mock("@/lib/analysis-checkout-readiness", () => ({
  assertAnalysisCheckoutOpen: mocks.assertOpen,
}));
vi.mock("@/lib/launch-offer.server", () => ({ readLaunchOfferState: mocks.launchState }));
vi.mock("@/lib/commercial-acceptance", () => ({
  recordCommercialAcceptance: vi.fn().mockResolvedValue(undefined),
  sendCommercialConfirmation: vi.fn(),
}));

import { createPlanCheckoutSession, stripeCustomerIdempotencyKey } from "@/lib/billing";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_ID = "cus_shared";
const consent = {
  termsAccepted: true,
  termsVersion: "2026-10-20.1",
  privacyVersion: "2026-10-21.1",
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
    mocks.launchState.mockResolvedValue({ active: false, degraded: false });
    mocks.sessionsExpire.mockResolvedValue({});
    mocks.sessionsList.mockResolvedValue({ data: [] });
    previousStripeSecret = process.env.STRIPE_SECRET_KEY;
    previousAnalysisPrice = process.env.STRIPE_ANALYSIS_PRICE_ID;
    process.env.STRIPE_SECRET_KEY = "sk_test_billing";
    process.env.STRIPE_ANALYSIS_PRICE_ID = "price_analysis";
    mocks.pricesRetrieve.mockResolvedValue({
      active: true,
      type: "recurring",
      currency: "eur",
      unit_amount: 5_900,
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

  it("refuse le checkout, sans réserver ni appeler Stripe, quand les paiements ne sont pas ouverts", async () => {
    mocks.assertOpen.mockImplementation(() => {
      throw new Error("Configuration du paiement incomplète: STRIPE_WEBHOOK_SECRET.");
    });

    await expect(
      createPlanCheckoutSession({
        auth: buildAuthContext(),
        origin: "https://immojudis.test",
        plan: "analyse",
        consent,
      }),
    ).rejects.toThrow(/WEBHOOK/);
    expect(mocks.adminRpc).not.toHaveBeenCalled();
    expect(mocks.pricesRetrieve).not.toHaveBeenCalled();
    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
  });

  it("transmet l'état de l'offre de lancement à la règle d'ouverture et refuse pendant l'offre", async () => {
    mocks.launchState.mockResolvedValue({ active: true, degraded: false });
    mocks.assertOpen.mockImplementation(
      (_env: unknown, options: { launchOfferActive?: boolean }) => {
        if (options.launchOfferActive) throw new Error("L'offre de lancement est en cours.");
      },
    );

    await expect(
      createPlanCheckoutSession({
        auth: buildAuthContext(),
        origin: "https://immojudis.test",
        plan: "analyse",
        consent,
      }),
    ).rejects.toThrow(/offre de lancement/);
    expect(mocks.assertOpen).toHaveBeenCalledWith(expect.anything(), { launchOfferActive: true });
    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
    expect(mocks.adminRpc).not.toHaveBeenCalled();
  });

  it("refuse le checkout quand l'état de l'offre de lancement est illisible", async () => {
    mocks.launchState.mockResolvedValue({ active: false, degraded: true });

    await expect(
      createPlanCheckoutSession({
        auth: buildAuthContext(),
        origin: "https://immojudis.test",
        plan: "analyse",
        consent,
      }),
    ).rejects.toThrow(/offre de lancement n'a pas pu être vérifié/);
    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
  });

  describe("réservation tenue par un checkout abandonné", () => {
    const abandoned = (overrides: Record<string, unknown> = {}) => ({
      id: "cs_abandoned",
      created: Math.floor(Date.now() / 1000) - 600,
      metadata: { user_id: USER_ID, checkout_reservation_token: "old-reservation-token" },
      ...overrides,
    });
    let reserveCalls = 0;

    beforeEach(() => {
      reserveCalls = 0;
      mocks.adminRpc.mockImplementation(async (name: string) => {
        if (name === "reserve_analyse_checkout") {
          reserveCalls += 1;
          // La réservation de l'ancien checkout tient jusqu'à sa libération.
          return { data: reserveCalls > 1, error: null };
        }
        if (name === "attach_analyse_checkout_customer") return { data: CUSTOMER_ID, error: null };
        if (name === "release_analyse_checkout") return { data: true, error: null };
        throw new Error(`Unexpected RPC ${name}`);
      });
    });

    it("expire le checkout ouvert et abandonné, libère sa réservation et en crée un nouveau", async () => {
      mocks.sessionsList.mockResolvedValue({ data: [abandoned()] });

      await expect(
        createPlanCheckoutSession({
          auth: buildAuthContext(CUSTOMER_ID),
          origin: "https://immojudis.test",
          plan: "analyse",
          consent,
        }),
      ).resolves.toEqual({ url: "https://checkout.stripe.test/cs_analysis" });

      expect(mocks.sessionsExpire).toHaveBeenCalledWith("cs_abandoned");
      expect(mocks.adminRpc).toHaveBeenCalledWith("release_analyse_checkout", {
        p_checkout_token: "old-reservation-token",
        p_user_id: USER_ID,
      });
      expect(reserveCalls).toBe(2);
    });

    it("ne touche pas à un checkout récent, qui peut être en cours de création", async () => {
      mocks.sessionsList.mockResolvedValue({
        data: [abandoned({ created: Math.floor(Date.now() / 1000) - 5 })],
      });

      await expect(
        createPlanCheckoutSession({
          auth: buildAuthContext(CUSTOMER_ID),
          origin: "https://immojudis.test",
          plan: "analyse",
          consent,
        }),
      ).rejects.toThrow(/déjà associé/i);
      expect(mocks.sessionsExpire).not.toHaveBeenCalled();
      expect(reserveCalls).toBe(1);
    });

    it("ne touche pas à la Session d'un autre compte ni à une Session sans réservation", async () => {
      mocks.sessionsList.mockResolvedValue({
        data: [
          abandoned({ metadata: { user_id: "someone-else", checkout_reservation_token: "t" } }),
          abandoned({ id: "cs_other", metadata: { user_id: USER_ID } }),
        ],
      });

      await expect(
        createPlanCheckoutSession({
          auth: buildAuthContext(CUSTOMER_ID),
          origin: "https://immojudis.test",
          plan: "analyse",
          consent,
        }),
      ).rejects.toThrow(/déjà associé/i);
      expect(mocks.sessionsExpire).not.toHaveBeenCalled();
    });

    it("garde le refus quand Stripe ne peut pas expirer la Session (déjà payée)", async () => {
      mocks.sessionsList.mockResolvedValue({ data: [abandoned()] });
      mocks.sessionsExpire.mockRejectedValue(new Error("session is complete"));

      await expect(
        createPlanCheckoutSession({
          auth: buildAuthContext(CUSTOMER_ID),
          origin: "https://immojudis.test",
          plan: "analyse",
          consent,
        }),
      ).rejects.toThrow(/déjà associé/i);
      expect(mocks.adminRpc).not.toHaveBeenCalledWith(
        "release_analyse_checkout",
        expect.anything(),
      );
    });
  });

  it("refuse un Price Stripe qui ne correspond pas aux 59 EUR mensuels validés", async () => {
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
    ).rejects.toThrow(/59 € \/ mois/);
    expect(mocks.adminRpc).not.toHaveBeenCalled();
  });
});

function buildAuthContext(customerId: string | null = null): SupabaseAuthContext {
  const row = {
    user_id: USER_ID,
    plan_code: "decouverte",
    status: "active",
    stripe_customer_id: customerId,
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
