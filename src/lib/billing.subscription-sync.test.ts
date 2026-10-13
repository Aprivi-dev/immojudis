import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  constructEvent: vi.fn(),
  subscriptionsRetrieve: vi.fn(),
  retrievePaymentMethod: vi.fn(),
  sendCommercialConfirmation: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock("stripe", () => ({
  default: class FakeStripe {
    webhooks = { constructEvent: mocks.constructEvent };
    subscriptions = { retrieve: mocks.subscriptionsRetrieve, update: vi.fn() };
    paymentMethods = { retrieve: mocks.retrievePaymentMethod };
    customers = { retrieve: vi.fn() };
  },
}));
vi.mock("@/lib/legal-documents", () => ({ assertPaidOfferLegalReadiness: vi.fn() }));
vi.mock("@/lib/commercial-acceptance", () => ({
  assertCommercialConfirmationReadiness: vi.fn(),
  recordCommercialAcceptance: vi.fn(),
  sendCommercialConfirmation: mocks.sendCommercialConfirmation,
}));

import type Stripe from "stripe";
import { handleStripeWebhook } from "@/lib/billing";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const PERIOD_END = 1_900_000_000;

function subscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: "sub_old",
    object: "subscription",
    status: "canceled",
    customer: "cus_1",
    metadata: { user_id: USER_ID },
    created: 1_790_000_000,
    items: { data: [{ current_period_end: PERIOD_END, price: { id: "price_a" } }] },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

type ApplyResult = { applied: boolean; reason: string };

/** Configure the database answer and return the webhook completion statuses. */
function stubRpc(apply: ApplyResult) {
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === "begin_stripe_webhook_event") return { data: true, error: null };
    if (name === "apply_stripe_subscription_state") return { data: [apply], error: null };
    return { data: null, error: null };
  });
}

const rpcCalls = (name: string) => mocks.rpc.mock.calls.filter(([called]) => called === name);
const completionStatus = () => rpcCalls("complete_stripe_webhook_event").at(-1)?.[1];

function deliver(type: string, object: unknown, created = 1_800_000_500) {
  mocks.constructEvent.mockReturnValue({
    id: `evt_${type}_${created}`,
    type,
    created,
    livemode: false,
    data: { object },
  });
  return handleStripeWebhook({ payload: "{}", signature: "sig" });
}

describe("synchronisation d'un abonnement Stripe d'un ancien identifiant", () => {
  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_sync");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_sync");
    vi.stubEnv("STRIPE_ANALYSIS_PRICE_ID", "price_a");
    mocks.rpc.mockReset();
    mocks.constructEvent.mockReset();
    mocks.subscriptionsRetrieve.mockReset();
    mocks.retrievePaymentMethod.mockReset();
    mocks.sendCommercialConfirmation.mockReset();
    mocks.sendCommercialConfirmation.mockResolvedValue(undefined);
    vi.restoreAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  it("traite le deleted tardif de l'ancien abonnement comme un succès sans changement", async () => {
    stubRpc({ applied: false, reason: "superseded_subscription" });
    mocks.subscriptionsRetrieve.mockResolvedValue(subscription());

    const result = await deliver("customer.subscription.deleted", subscription());

    expect(result.handled).toBe(true);
    expect(completionStatus()).toMatchObject({ p_processing_status: "processed" });
    expect(rpcCalls("complete_stripe_webhook_event")).toHaveLength(1);
    const [, args] = rpcCalls("apply_stripe_subscription_state")[0];
    // The id sent is the one read back from Stripe, so the database can compare it
    // with the subscription stored for the user.
    expect(args).toMatchObject({
      p_stripe_subscription_id: "sub_old",
      p_status: "cancelled",
      p_user_id: USER_ID,
    });
    expect(mocks.retrievePaymentMethod).not.toHaveBeenCalled();
  });

  it("envoie l'état relu chez Stripe quand l'événement rejoué annonce encore active", async () => {
    stubRpc({ applied: false, reason: "superseded_subscription" });
    mocks.subscriptionsRetrieve.mockResolvedValue(subscription({ status: "canceled" }));

    const result = await deliver(
      "customer.subscription.updated",
      subscription({ status: "active" }),
      1_800_000_100,
    );

    expect(mocks.subscriptionsRetrieve).toHaveBeenCalledWith("sub_old");
    expect(rpcCalls("apply_stripe_subscription_state")[0][1]).toMatchObject({
      p_status: "cancelled",
      p_stripe_subscription_id: "sub_old",
      p_event_created: 1_800_000_100,
    });
    expect(result.handled).toBe(true);
    expect(completionStatus()).toMatchObject({ p_processing_status: "processed" });
  });

  it("applique un réabonnement normal et ne signale rien d'ignoré", async () => {
    stubRpc({ applied: true, reason: "applied" });
    const renewed = subscription({ id: "sub_new", status: "active" });
    mocks.subscriptionsRetrieve.mockResolvedValue(renewed);

    const result = await deliver("customer.subscription.created", renewed);

    expect(rpcCalls("apply_stripe_subscription_state")[0][1]).toMatchObject({
      p_stripe_subscription_id: "sub_new",
      p_status: "active",
    });
    expect(result.handled).toBe(true);
    expect(completionStatus()).toMatchObject({ p_processing_status: "processed" });
    expect(console.info).not.toHaveBeenCalled();
  });

  it("garde un checkout.session.completed d'abonnement valide après un refus de remplacement", async () => {
    stubRpc({ applied: false, reason: "superseded_subscription" });
    mocks.subscriptionsRetrieve.mockResolvedValue(subscription());
    const session = {
      id: "cs_1",
      mode: "subscription",
      metadata: { user_id: USER_ID, checkout_reservation_token: "tok_1" },
      subscription: subscription(),
    };

    const result = await deliver("checkout.session.completed", session);

    expect(result.handled).toBe(true);
    expect(rpcCalls("release_analyse_checkout")).toHaveLength(1);
    expect(completionStatus()).toMatchObject({ p_processing_status: "processed" });
  });

  it("journalise le refus avec son motif", async () => {
    stubRpc({ applied: false, reason: "superseded_subscription" });
    mocks.subscriptionsRetrieve.mockResolvedValue(subscription());

    await deliver("customer.subscription.deleted", subscription());

    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining("ignored"),
      expect.objectContaining({ subscription: "sub_old", reason: "superseded_subscription" }),
    );
  });

  it.each(["stale_event", "payment_reversed"])(
    "garde %s comme événement ignoré, sans échec ni rejeu",
    async (reason) => {
      stubRpc({ applied: false, reason });
      const active = subscription({ id: "sub_new", status: "active" });
      mocks.subscriptionsRetrieve.mockResolvedValue(active);

      const result = await deliver("customer.subscription.updated", active);

      expect(result.handled).toBe(false);
      expect(completionStatus()).toMatchObject({ p_processing_status: "ignored" });
      expect(mocks.retrievePaymentMethod).not.toHaveBeenCalled();
    },
  );

  it("marque l'événement en échec quand la base refuse la synchronisation", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "begin_stripe_webhook_event") return { data: true, error: null };
      if (name === "apply_stripe_subscription_state") {
        return { data: null, error: { message: "boom" } };
      }
      return { data: null, error: null };
    });
    mocks.subscriptionsRetrieve.mockResolvedValue(subscription());

    await expect(deliver("customer.subscription.deleted", subscription())).rejects.toThrow("boom");
    expect(completionStatus()).toMatchObject({ p_processing_status: "failed" });
  });
});
