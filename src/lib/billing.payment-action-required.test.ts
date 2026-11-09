import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  constructEvent: vi.fn(),
  sendActionRequired: vi.fn(),
  sendFailed: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc, from: mocks.from },
}));
vi.mock("stripe", () => ({
  default: class FakeStripe {
    webhooks = { constructEvent: mocks.constructEvent };
  },
}));
vi.mock("@/lib/billing-notices", () => ({
  sendCancellationConfirmationNotice: vi.fn(),
  sendPaymentActionRequiredNotice: mocks.sendActionRequired,
  sendPaymentFailedNotice: mocks.sendFailed,
  sendTrialEndingNotice: vi.fn(),
}));
vi.mock("@/lib/commercial-acceptance", () => ({
  recordCommercialAcceptance: vi.fn(),
  sendCommercialConfirmation: vi.fn(),
}));

import { handleStripeWebhook } from "@/lib/billing";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const HOSTED_URL = "https://invoice.stripe.com/i/acct_1/test_1";

function subscriptionRow(userId: string | null) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "limit"]) query[method] = () => query;
  query.maybeSingle = () =>
    Promise.resolve({ data: userId ? { user_id: userId } : null, error: null });
  return query;
}

let eventCounter = 0;
function deliver(type: string, invoice: Record<string, unknown>) {
  eventCounter += 1;
  mocks.constructEvent.mockReturnValue({
    id: `evt_action_${eventCounter}`,
    type,
    created: 1_800_000_500,
    livemode: false,
    data: { object: { id: "in_1", customer: "cus_1", ...invoice } },
  });
  return handleStripeWebhook({ payload: "{}", signature: "sig" });
}

describe("3-D Secure au renouvellement (invoice.payment_action_required)", () => {
  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_action");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_action");
    vi.clearAllMocks();
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "begin_stripe_webhook_event"
        ? { data: true, error: null }
        : { data: null, error: null },
    );
    mocks.from.mockImplementation(() => subscriptionRow(USER_ID));
  });

  it("asks the subscriber to confirm a renewal with the Stripe payment page", async () => {
    const result = await deliver("invoice.payment_action_required", {
      billing_reason: "subscription_cycle",
      hosted_invoice_url: HOSTED_URL,
    });

    expect(result.handled).toBe(true);
    expect(mocks.sendActionRequired).toHaveBeenCalledWith({
      userId: USER_ID,
      invoiceId: "in_1",
      hostedInvoiceUrl: HOSTED_URL,
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "complete_stripe_webhook_event",
      expect.objectContaining({ p_processing_status: "processed" }),
    );
  });

  it("leaves the first invoice to Checkout, which runs 3-D Secure itself", async () => {
    const result = await deliver("invoice.payment_action_required", {
      billing_reason: "subscription_create",
      hosted_invoice_url: HOSTED_URL,
    });

    expect(result.handled).toBe(false);
    expect(mocks.sendActionRequired).not.toHaveBeenCalled();
  });

  it("ignores an invoice whose customer is unknown", async () => {
    mocks.from.mockImplementation(() => subscriptionRow(null));
    const result = await deliver("invoice.payment_action_required", {
      billing_reason: "subscription_cycle",
    });

    expect(result.handled).toBe(false);
    expect(mocks.sendActionRequired).not.toHaveBeenCalled();
  });

  it("keeps the payment failure notice on invoice.payment_failed", async () => {
    const result = await deliver("invoice.payment_failed", { next_payment_attempt: 1_800_100_000 });

    expect(result.handled).toBe(true);
    expect(mocks.sendFailed).toHaveBeenCalledWith({
      userId: USER_ID,
      invoiceId: "in_1",
      nextAttemptAt: 1_800_100_000,
    });
    expect(mocks.sendActionRequired).not.toHaveBeenCalled();
  });
});
