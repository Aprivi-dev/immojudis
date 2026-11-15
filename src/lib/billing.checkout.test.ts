import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { CheckoutConsent } from "@/lib/commercial-acceptance";
import { LEGAL_DOCUMENTS } from "@/lib/legal-documents";
import { ConfigurationError, PublicApiError } from "@/lib/api-errors";

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
  couponsCreate: vi.fn(),
  couponsDel: vi.fn(),
  constructEvent: vi.fn(),
  from: vi.fn(),
  events: [] as string[],
}));

vi.mock("stripe", () => ({
  default: class FakeStripe {
    customers = { create: mocks.customersCreate };
    prices = { retrieve: mocks.pricesRetrieve };
    subscriptions = { list: mocks.subscriptionsList };
    coupons = { create: mocks.couponsCreate, del: mocks.couponsDel };
    webhooks = { constructEvent: mocks.constructEvent };
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
  supabaseAdmin: { rpc: mocks.adminRpc, from: mocks.from },
}));
vi.mock("@/lib/analysis-checkout-readiness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analysis-checkout-readiness")>()),
  assertAnalysisCheckoutOpen: mocks.assertOpen,
}));
vi.mock("@/lib/launch-offer.server", () => ({ readLaunchOfferState: mocks.launchState }));
vi.mock("@/lib/commercial-acceptance", () => ({
  recordCommercialAcceptance: vi.fn().mockResolvedValue(undefined),
  sendCommercialConfirmation: vi.fn(),
}));

import {
  createPlanCheckoutSession,
  handleStripeWebhook,
  stripeCustomerIdempotencyKey,
  VAT_EXEMPTION_INVOICE_MENTION,
} from "@/lib/billing";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_ID = "cus_shared";
const consent = {
  termsAccepted: true,
  termsVersion: LEGAL_DOCUMENTS.terms.version,
  privacyVersion: LEGAL_DOCUMENTS.privacy.version,
  paymentObligationAcknowledged: true,
  immediatePerformanceRequested: true,
  withdrawalInformationAcknowledged: true,
} satisfies CheckoutConsent;

describe("createPlanCheckoutSession customer reservation", () => {
  let previousStripeSecret: string | undefined;
  let previousAnalysisPrice: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    // Un test qui fait refuser la règle d'ouverture ne la laisse pas refuser pour les suivants.
    mocks.assertOpen.mockReset();
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
      tax_behavior: "inclusive",
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
      // Aucun achat à l'unité à déduire du premier mois.
      if (name === "reserve_unit_purchase_deduction") return { data: 0, error: null };
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
    // Refus métier typé (409) : son texte cite Stripe, il ne doit pas finir en 500 générique.
    await expect(second).rejects.toBeInstanceOf(PublicApiError);
    await expect(second).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/déjà associé/i),
    });

    expect(mocks.customersCreate).toHaveBeenCalledTimes(1);
    expect(mocks.customersCreate.mock.calls[0]?.[1]).toEqual({
      idempotencyKey: stripeCustomerIdempotencyKey(USER_ID),
    });
    // Franchise en base de TVA : la mention légale figure en pied de chaque facture du client.
    expect(mocks.customersCreate.mock.calls[0]?.[0]).toMatchObject({
      invoice_settings: { footer: VAT_EXEMPTION_INVOICE_MENTION },
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
      throw new ConfigurationError("Configuration du paiement incomplète: STRIPE_WEBHOOK_SECRET.");
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

  it("n'ajoute pas d'essai Stripe : l'essai gratuit est accordé à l'inscription", async () => {
    mocks.customersCreate.mockResolvedValue({ id: CUSTOMER_ID });

    await createPlanCheckoutSession({
      auth: buildAuthContext(),
      origin: "https://immojudis.test",
      plan: "analyse",
      consent,
    });

    const params = mocks.checkoutCreate.mock.calls[0]?.[0] as {
      subscription_data?: { trial_period_days?: number; metadata?: Record<string, string> };
    };
    expect(params.subscription_data?.trial_period_days).toBeUndefined();
    expect(params.subscription_data?.metadata?.trial_days).toBe("0");
  });

  it("ne dépend pas de l'essai gratuit à l'inscription : seule la règle d'ouverture décide", async () => {
    mocks.assertOpen.mockImplementationOnce(() => {
      throw new ConfigurationError(
        "Configuration du paiement incomplète. Le checkout est suspendu.",
      );
    });

    await expect(
      createPlanCheckoutSession({
        auth: buildAuthContext(),
        origin: "https://immojudis.test",
        plan: "analyse",
        consent,
      }),
    ).rejects.toThrow(/checkout est suspendu/);
    expect(mocks.assertOpen).toHaveBeenCalledWith(expect.anything());
    expect(mocks.launchState).not.toHaveBeenCalled();
    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
    expect(mocks.adminRpc).not.toHaveBeenCalled();
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
        if (name === "reserve_unit_purchase_deduction") return { data: 0, error: null };
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
    await expect(
      createPlanCheckoutSession({
        auth: buildAuthContext(),
        origin: "https://immojudis.test",
        plan: "analyse",
        consent,
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    expect(mocks.adminRpc).not.toHaveBeenCalled();
  });

  // n° 45 : le tarif de 59 € est TTC ; un Price « exclusive » ou sans comportement fiscal est refusé.
  it.each(["exclusive", "unspecified", undefined])(
    "refuse un Price Stripe dont le comportement fiscal est %s (le prix doit être TTC)",
    async (taxBehavior) => {
      mocks.pricesRetrieve.mockResolvedValue({
        active: true,
        type: "recurring",
        currency: "eur",
        unit_amount: 5_900,
        tax_behavior: taxBehavior,
        recurring: { interval: "month", interval_count: 1 },
      });

      await expect(
        createPlanCheckoutSession({
          auth: buildAuthContext(),
          origin: "https://immojudis.test",
          plan: "analyse",
          consent,
        }),
      ).rejects.toThrow(/inclusive/);
      await expect(
        createPlanCheckoutSession({
          auth: buildAuthContext(),
          origin: "https://immojudis.test",
          plan: "analyse",
          consent,
        }),
      ).rejects.toBeInstanceOf(ConfigurationError);
      expect(mocks.adminRpc).not.toHaveBeenCalled();
      expect(mocks.checkoutCreate).not.toHaveBeenCalled();
    },
  );
});

describe("déduction des achats à l'unité sur le premier mois d'abonnement", () => {
  let deductionCents = 0;
  let settledCents = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertOpen.mockReset();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_billing");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_billing");
    vi.stubEnv("STRIPE_ANALYSIS_PRICE_ID", "price_analysis");
    vi.stubEnv("STRIPE_ANALYSIS_PRODUCT_ID", "");
    deductionCents = 1_900;
    settledCents = 1_900;
    mocks.pricesRetrieve.mockResolvedValue({
      active: true,
      type: "recurring",
      currency: "eur",
      unit_amount: 5_900,
      tax_behavior: "inclusive",
      recurring: { interval: "month", interval_count: 1 },
    });
    mocks.subscriptionsList.mockResolvedValue({ data: [], has_more: false });
    mocks.sessionsList.mockResolvedValue({ data: [] });
    mocks.sessionsExpire.mockResolvedValue({});
    mocks.customersCreate.mockResolvedValue({ id: CUSTOMER_ID });
    mocks.couponsCreate.mockResolvedValue({ id: "coupon_unit" });
    mocks.couponsDel.mockResolvedValue({ deleted: true });
    mocks.checkoutCreate.mockResolvedValue({
      id: "cs_analysis",
      url: "https://checkout.stripe.test/cs_analysis",
      created: 1_800_000_000,
      status: "open",
    });
    mocks.from.mockImplementation(() => {
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq", "limit"]) query[method] = () => query;
      query.maybeSingle = async () => ({ data: { processing_status: "processed" }, error: null });
      return query;
    });
    mocks.adminRpc.mockImplementation(async (name: string) => {
      if (name === "reserve_analyse_checkout") return { data: true, error: null };
      if (name === "attach_analyse_checkout_customer") return { data: CUSTOMER_ID, error: null };
      if (name === "reserve_unit_purchase_deduction") return { data: deductionCents, error: null };
      if (name === "begin_stripe_webhook_event") return { data: true, error: null };
      if (name === "settle_unit_purchase_deduction") return { data: settledCents, error: null };
      return { data: null, error: null };
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  const rpcCalls = (name: string) =>
    mocks.adminRpc.mock.calls.filter(([called]) => called === name);
  const checkout = () =>
    createPlanCheckoutSession({
      auth: buildAuthContext(),
      origin: "https://immojudis.test",
      plan: "analyse",
      consent,
    });
  const sessionParams = () =>
    mocks.checkoutCreate.mock.calls[0]?.[0] as {
      discounts?: Array<{ coupon: string }>;
      allow_promotion_codes?: boolean;
      metadata: Record<string, string>;
    };

  it("premier abonnement : un bon unique du montant réservé, seule remise de la session", async () => {
    await checkout();

    const [, reserveArgs] = rpcCalls("reserve_unit_purchase_deduction")[0]!;
    const token = (reserveArgs as { p_token: string }).p_token;
    expect(reserveArgs).toMatchObject({ p_user_id: USER_ID, p_now: expect.any(String) });
    // Même jeton que la réservation du checkout : règlement et libération le retrouvent.
    expect(rpcCalls("reserve_analyse_checkout")[0]![1]).toMatchObject({ p_checkout_token: token });
    const [couponParams, couponOptions] = mocks.couponsCreate.mock.calls[0]!;
    expect(couponParams).toEqual({
      amount_off: 1_900,
      currency: "eur",
      duration: "once",
      max_redemptions: 1,
      name: expect.any(String),
      metadata: {
        user_id: USER_ID,
        checkout_reservation_token: token,
        purpose: "unit_purchase_deduction",
      },
    });
    expect(couponOptions).toEqual({ idempotencyKey: `immojudis-unit-deduction-${token}` });
    expect(sessionParams().discounts).toEqual([{ coupon: "coupon_unit" }]);
    expect(sessionParams().allow_promotion_codes).toBeUndefined();
    expect(sessionParams().metadata).toMatchObject({
      unit_purchase_deduction_coupon: "coupon_unit",
      unit_purchase_deduction_cents: "1900",
    });
  });

  it("plafonne la déduction au prix du premier mois (5 900 centimes)", async () => {
    deductionCents = 7_600;

    await checkout();

    expect(mocks.couponsCreate.mock.calls[0]![0]).toMatchObject({ amount_off: 5_900 });
    expect(sessionParams().metadata.unit_purchase_deduction_cents).toBe("5900");
  });

  it("limite le bon au produit Analyse quand STRIPE_ANALYSIS_PRODUCT_ID est posé", async () => {
    vi.stubEnv("STRIPE_ANALYSIS_PRODUCT_ID", "prod_analysis");

    await checkout();

    expect(mocks.couponsCreate.mock.calls[0]![0]).toMatchObject({
      applies_to: { products: ["prod_analysis"] },
    });
  });

  it("rien à déduire : ni bon ni remise", async () => {
    deductionCents = 0;

    await checkout();

    expect(mocks.couponsCreate).not.toHaveBeenCalled();
    expect(sessionParams()).not.toHaveProperty("discounts");
  });

  it("compte déjà abonné par le passé : aucune déduction réservée", async () => {
    mocks.subscriptionsList.mockResolvedValue({
      data: [{ id: "sub_old", status: "canceled", trial_start: null, trial_end: null }],
      has_more: false,
    });

    await checkout();

    expect(rpcCalls("reserve_unit_purchase_deduction")).toHaveLength(0);
    expect(mocks.couponsCreate).not.toHaveBeenCalled();
    expect(sessionParams()).not.toHaveProperty("discounts");
  });

  it("checkout en échec : la déduction est rendue et le bon supprimé", async () => {
    mocks.checkoutCreate.mockRejectedValue(new Error("stripe down"));

    await expect(checkout()).rejects.toThrow("stripe down");

    const token = (rpcCalls("reserve_unit_purchase_deduction")[0]![1] as { p_token: string })
      .p_token;
    expect(rpcCalls("release_unit_purchase_deduction")[0]![1]).toEqual({ p_token: token });
    expect(mocks.couponsDel).toHaveBeenCalledWith("coupon_unit");
  });

  function deliver(type: string, object: unknown) {
    mocks.constructEvent.mockReturnValue({
      id: `evt_${type}`,
      type,
      created: 1_800_000_500,
      livemode: false,
      data: { object },
    });
    return handleStripeWebhook({ payload: "{}", signature: "sig" });
  }

  const deductionSession = {
    id: "cs_analysis",
    mode: "subscription",
    subscription: null,
    metadata: {
      user_id: USER_ID,
      checkout_reservation_token: "token-of-the-checkout-0001",
      unit_purchase_deduction_coupon: "coupon_unit",
      unit_purchase_deduction_cents: "1900",
    },
  };

  it("réglée au checkout.session.completed de l'abonnement", async () => {
    await deliver("checkout.session.completed", deductionSession);

    expect(rpcCalls("settle_unit_purchase_deduction")[0]![1]).toEqual({
      p_token: "token-of-the-checkout-0001",
      p_checkout_session_id: "cs_analysis",
    });
    expect(rpcCalls("release_unit_purchase_deduction")).toHaveLength(0);
    expect(mocks.couponsDel).not.toHaveBeenCalled();
  });

  it("réglée sans écart : aucune alerte", async () => {
    const alert = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await deliver("checkout.session.completed", deductionSession);

    expect(alert).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  it("journalise au format du rapprochement un règlement inférieur au bon (achat remboursé entre-temps)", async () => {
    settledCents = 0;
    const alert = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await deliver("checkout.session.completed", deductionSession);

    expect(alert).toHaveBeenCalledWith(expect.stringContaining("deduction settlement mismatch"), {
      kind: "unit_deduction_settlement_mismatch",
      stripeSubscriptionId: null,
      stripeCheckoutSessionId: "cs_analysis",
      userId: USER_ID,
      detail: expect.stringMatching(/1900 centimes.*0 centimes/),
    });
    // L'écart n'empêche pas le traitement de l'abonnement ni ne fait rejouer l'événement.
    expect(result.eventId).toBe("evt_checkout.session.completed");
    alert.mockRestore();
  });

  it("libérée au checkout.session.expired, et le bon supprimé", async () => {
    await deliver("checkout.session.expired", deductionSession);

    expect(rpcCalls("release_analyse_checkout")).toHaveLength(1);
    expect(rpcCalls("release_unit_purchase_deduction")[0]![1]).toEqual({
      p_token: "token-of-the-checkout-0001",
    });
    expect(mocks.couponsDel).toHaveBeenCalledWith("coupon_unit");
    expect(rpcCalls("settle_unit_purchase_deduction")).toHaveLength(0);
  });

  it("un checkout expiré sans déduction ne touche à aucun achat", async () => {
    await deliver("checkout.session.expired", {
      ...deductionSession,
      metadata: { user_id: USER_ID, checkout_reservation_token: "token-of-the-checkout-0001" },
    });

    expect(rpcCalls("release_unit_purchase_deduction")).toHaveLength(0);
    expect(mocks.couponsDel).not.toHaveBeenCalled();
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
