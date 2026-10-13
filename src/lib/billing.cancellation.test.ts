import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  getUserById: vi.fn(),
  constructEvent: vi.fn(),
  subscriptionsRetrieve: vi.fn(),
  sendResendEmail: vi.fn(),
  resolveConfig: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc, auth: { admin: { getUserById: mocks.getUserById } } },
}));
vi.mock("stripe", () => ({
  default: class FakeStripe {
    webhooks = { constructEvent: mocks.constructEvent };
    subscriptions = { retrieve: mocks.subscriptionsRetrieve, update: vi.fn() };
    paymentMethods = { retrieve: vi.fn() };
    customers = { retrieve: vi.fn() };
  },
}));
vi.mock("@/lib/email-alerts", () => ({
  resolveEmailAlertDeliveryConfig: mocks.resolveConfig,
  sendResendEmail: mocks.sendResendEmail,
}));
vi.mock("@/lib/legal-documents", () => ({ assertPaidOfferLegalReadiness: vi.fn() }));
vi.mock("@/lib/commercial-acceptance", () => ({
  assertCommercialConfirmationReadiness: vi.fn(),
  recordCommercialAcceptance: vi.fn(),
  sendCommercialConfirmation: vi.fn(),
}));

import type Stripe from "stripe";
import { cancellationNoticeKind, handleStripeWebhook } from "@/lib/billing";

const USER_ID = "11111111-1111-4111-8111-111111111111";
// 2030-03-17T17:46:40Z
const PERIOD_END = 1_900_000_000;
const REQUESTED_AT = 1_800_000_400;

function subscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: "sub_1",
    object: "subscription",
    status: "active",
    customer: "cus_1",
    metadata: { user_id: USER_ID },
    created: 1_790_000_000,
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    trial_end: null,
    cancellation_details: null,
    items: { data: [{ current_period_end: PERIOD_END, price: { id: "price_a" } }] },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

const scheduled = (overrides: Partial<Stripe.Subscription> = {}) =>
  subscription({
    cancel_at_period_end: true,
    cancel_at: PERIOD_END,
    canceled_at: REQUESTED_AT,
    ...overrides,
  });

let eventCounter = 0;
/** Stripe event ids already seen: the journal answers `false` for a replayed one. */
let seenEvents = new Set<string>();

function stubRpc() {
  mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "begin_stripe_webhook_event") {
      const id = String(args.p_event_id);
      const isNew = !seenEvents.has(id);
      seenEvents.add(id);
      return { data: isNew, error: null };
    }
    if (name === "apply_stripe_subscription_state") {
      return { data: [{ applied: true, reason: "applied" }], error: null };
    }
    return { data: null, error: null };
  });
}

function deliver(
  type: string,
  object: Stripe.Subscription,
  options: { previous?: Partial<Stripe.Subscription>; id?: string; created?: number } = {},
) {
  eventCounter += 1;
  const id = options.id ?? `evt_${eventCounter}`;
  mocks.constructEvent.mockReturnValue({
    id,
    type,
    created: options.created ?? 1_800_000_500,
    livemode: false,
    data: { object, ...(options.previous ? { previous_attributes: options.previous } : {}) },
  });
  return handleStripeWebhook({ payload: "{}", signature: "sig" });
}

describe("confirmation de résiliation par email", () => {
  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_cancel");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_cancel");
    vi.stubEnv("STRIPE_ANALYSIS_PRICE_ID", "price_a");
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    seenEvents = new Set();
    stubRpc();
    mocks.resolveConfig.mockReturnValue({
      configured: true,
      apiKey: "re_test",
      from: "Immojudis <alertes@immojudis.test>",
      appUrl: "https://immojudis.test",
    });
    mocks.getUserById.mockResolvedValue({
      data: { user: { email: "abonne@example.test" } },
      error: null,
    });
    mocks.sendResendEmail.mockResolvedValue({ id: "email_1" });
  });

  it("envoie un email quand l'annulation en fin de période est programmée", async () => {
    mocks.subscriptionsRetrieve.mockResolvedValue(scheduled());

    const result = await deliver("customer.subscription.updated", scheduled(), {
      previous: { cancel_at_period_end: false },
    });

    expect(result.handled).toBe(true);
    expect(mocks.sendResendEmail).toHaveBeenCalledTimes(1);
    const call = mocks.sendResendEmail.mock.calls[0]![0];
    expect(call.idempotencyKey).toBe(`immojudis-cancellation-confirmation-sub_1-${REQUESTED_AT}`);
    expect(call.message).toMatchObject({
      to: "abonne@example.test",
      subject: "Confirmation de votre résiliation",
    });
    expect(call.message.text).toContain("bien reçu votre demande de résiliation");
    expect(call.message.text).toContain("17 mars 2030");
    expect(call.message.text).toContain("Votre compte Découverte et vos données restent");
  });

  it("n'envoie qu'un email quand le même événement est rejoué", async () => {
    mocks.subscriptionsRetrieve.mockResolvedValue(scheduled());

    const first = await deliver("customer.subscription.updated", scheduled(), {
      id: "evt_cancel",
      previous: { cancel_at_period_end: false },
    });
    const replay = await deliver("customer.subscription.updated", scheduled(), {
      id: "evt_cancel",
      previous: { cancel_at_period_end: false },
    });

    expect(first.duplicate).toBeUndefined();
    expect(replay).toMatchObject({ handled: true, duplicate: true });
    expect(mocks.sendResendEmail).toHaveBeenCalledTimes(1);
  });

  it("n'envoie rien pour les autres événements de la même résiliation", async () => {
    mocks.subscriptionsRetrieve.mockResolvedValue(scheduled());

    // Another attribute changed while the cancellation was already scheduled.
    await deliver("customer.subscription.updated", scheduled(), {
      previous: { cancel_at: null },
    });
    // The subscription finally ends at the period end.
    await deliver("customer.subscription.deleted", scheduled({ status: "canceled" }));

    expect(mocks.sendResendEmail).not.toHaveBeenCalled();
  });

  it("n'envoie rien tant que l'abonnement n'est pas résilié", async () => {
    mocks.subscriptionsRetrieve.mockResolvedValue(subscription());

    await deliver("customer.subscription.updated", subscription(), {
      previous: { status: "trialing" },
    });
    await deliver("customer.subscription.created", subscription());

    expect(mocks.sendResendEmail).not.toHaveBeenCalled();
  });

  it("n'envoie rien si la résiliation programmée a été annulée entre-temps", async () => {
    mocks.subscriptionsRetrieve.mockResolvedValue(subscription());

    await deliver("customer.subscription.updated", scheduled(), {
      previous: { cancel_at_period_end: false },
    });

    expect(mocks.sendResendEmail).not.toHaveBeenCalled();
  });

  it("confirme une résiliation immédiate, avec la date de fin déjà passée", async () => {
    const canceled = subscription({
      status: "canceled",
      canceled_at: REQUESTED_AT,
      ended_at: REQUESTED_AT,
      cancellation_details: { reason: "cancellation_requested" } as never,
    });
    mocks.subscriptionsRetrieve.mockResolvedValue(canceled);

    await deliver("customer.subscription.deleted", canceled);

    expect(mocks.sendResendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendResendEmail.mock.calls[0]![0].message.text).toContain("a pris fin le");
  });

  it("ne présente pas comme une résiliation un abonnement coupé pour impayé", async () => {
    const canceled = subscription({
      status: "canceled",
      ended_at: REQUESTED_AT,
      cancellation_details: { reason: "payment_failed" } as never,
    });
    mocks.subscriptionsRetrieve.mockResolvedValue(canceled);

    await deliver("customer.subscription.deleted", canceled);

    expect(mocks.sendResendEmail).not.toHaveBeenCalled();
  });

  it("ne fait pas échouer le webhook quand l'envoi échoue", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.subscriptionsRetrieve.mockResolvedValue(scheduled());
    mocks.sendResendEmail.mockRejectedValue(new Error("resend down"));

    const result = await deliver("customer.subscription.updated", scheduled(), {
      previous: { cancel_at_period_end: false },
    });

    expect(result.handled).toBe(true);
    const completion = mocks.rpc.mock.calls.filter(
      ([name]) => name === "complete_stripe_webhook_event",
    );
    expect(completion.at(-1)?.[1]).toMatchObject({ p_processing_status: "processed" });
  });

  it("n'envoie rien quand Resend n'est pas configuré", async () => {
    mocks.resolveConfig.mockReturnValue({ configured: false });
    mocks.subscriptionsRetrieve.mockResolvedValue(scheduled());

    const result = await deliver("customer.subscription.updated", scheduled(), {
      previous: { cancel_at_period_end: false },
    });

    expect(result.handled).toBe(true);
    expect(mocks.sendResendEmail).not.toHaveBeenCalled();
  });

  it("précise qu'aucun montant n'est prélevé quand la résiliation intervient pendant l'essai", async () => {
    const trialing = scheduled({ status: "trialing", trial_end: PERIOD_END });
    mocks.subscriptionsRetrieve.mockResolvedValue(trialing);

    await deliver("customer.subscription.updated", trialing, {
      previous: { cancel_at_period_end: false },
    });

    expect(mocks.sendResendEmail.mock.calls[0]![0].message.text).toContain(
      "aucun montant ne sera prélevé",
    );
  });
});

describe("cancellationNoticeKind", () => {
  it("ne retient qu'un passage de cancel_at_period_end de faux à vrai", () => {
    const base = { payloadSubscription: scheduled(), current: scheduled() };
    expect(
      cancellationNoticeKind({
        ...base,
        eventType: "customer.subscription.updated",
        previousAttributes: { cancel_at_period_end: false },
      }),
    ).toBe("scheduled");
    expect(
      cancellationNoticeKind({
        ...base,
        eventType: "customer.subscription.updated",
        previousAttributes: {},
      }),
    ).toBeNull();
    expect(
      cancellationNoticeKind({ ...base, eventType: "customer.subscription.updated" }),
    ).toBeNull();
    expect(cancellationNoticeKind({ ...base, eventType: "invoice.payment_failed" })).toBeNull();
  });
});
