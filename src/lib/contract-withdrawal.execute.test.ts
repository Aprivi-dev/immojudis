import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  subscriptionsRetrieve: vi.fn(),
  subscriptionsCancel: vi.fn(),
  chargesList: vi.fn(),
  refundsCreate: vi.fn(),
  updatePrivacyRequest: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from },
}));
vi.mock("@/lib/billing", () => ({
  getStripe: () => ({
    subscriptions: { retrieve: mocks.subscriptionsRetrieve, cancel: mocks.subscriptionsCancel },
    charges: { list: mocks.chargesList },
    refunds: { create: mocks.refundsCreate },
  }),
}));
vi.mock("@/lib/privacy-requests", () => ({
  updatePrivacyRequestForAdmin: mocks.updatePrivacyRequest,
}));

import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { executeContractWithdrawal } from "./contract-withdrawal";

const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const auth = { isAdmin: true, userId: "admin" } as unknown as SupabaseAuthContext;
const periodStart = Date.UTC(2026, 9, 1) / 1000;
const periodEnd = Date.UTC(2026, 9, 31) / 1000;

function chain(result: { data: unknown; error: unknown }) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "update"]) query[method] = () => query;
  query.single = () => Promise.resolve(result);
  query.maybeSingle = () => Promise.resolve(result);
  query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return query;
}

/** Abonnement résilié dont la dernière facture a été réglée par `paymentIntent` (null : rien d'encaissé). */
function subscription(paymentIntent: string | null) {
  return {
    id: "sub_1",
    status: "canceled",
    items: { data: [{ current_period_start: periodStart, current_period_end: periodEnd }] },
    latest_invoice: {
      id: "in_latest",
      amount_paid: paymentIntent ? 5_900 : 0,
      payments: {
        data: paymentIntent
          ? [{ status: "paid", payment: { type: "payment_intent", payment_intent: paymentIntent } }]
          : [],
      },
    },
  };
}

function charge(
  id: string,
  paymentIntent: string,
  overrides: { amount_refunded?: number; refunded?: boolean; refunds?: unknown[] } = {},
) {
  const { refunds = [], ...rest } = overrides;
  return {
    id,
    payment_intent: paymentIntent,
    paid: true,
    refunded: false,
    amount: 5_900,
    amount_refunded: 0,
    refunds: { data: refunds },
    ...rest,
  };
}

const withdrawalRefund = {
  id: "re_1",
  amount: 5_900,
  status: "succeeded",
  metadata: { reason: "contract_withdrawal", withdrawal_request_id: REQUEST_ID },
};

function run(refundMode: "prorata" | "full", now: string) {
  return executeContractWithdrawal({
    auth,
    input: { requestId: REQUEST_ID, refundMode, confirm: true },
    now: new Date(now),
  });
}

describe("executeContractWithdrawal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.from.mockImplementation((table: string) =>
      table === "data_subject_requests"
        ? chain({
            data: {
              id: REQUEST_ID,
              request_type: "contract_withdrawal",
              status: "in_progress",
              user_id: USER_ID,
            },
            error: null,
          })
        : chain({
            data: { stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1" },
            error: null,
          }),
    );
    mocks.subscriptionsRetrieve.mockResolvedValue(subscription("pi_latest"));
    mocks.updatePrivacyRequest.mockImplementation(async ({ input }) => input);
  });

  // Audit du 14/11/2026 (D3), relecture de la PR #502 : la route valide déjà `confirm: true` ; le
  // module le revérifie, pour un appel qui ne passerait pas par elle.
  it.each([false, undefined, "oui"])(
    "refuses an unconfirmed withdrawal (confirm: %j) before reading or changing anything",
    async (confirm) => {
      await expect(
        executeContractWithdrawal({
          auth,
          input: { requestId: REQUEST_ID, refundMode: "full", confirm } as never,
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(mocks.from).not.toHaveBeenCalled();
      expect(mocks.subscriptionsCancel).not.toHaveBeenCalled();
      expect(mocks.refundsCreate).not.toHaveBeenCalled();
    },
  );

  it("tags the refund with the request so that a retry can find it", async () => {
    mocks.chargesList.mockResolvedValue({
      data: [charge("ch_1", "pi_latest")],
      has_more: false,
    });

    const result = await run("prorata", "2026-10-04T00:00:00.000Z");

    expect(result.refundedCents).toBe(5_310);
    expect(mocks.subscriptionsRetrieve).toHaveBeenCalledWith("sub_1", {
      expand: ["latest_invoice.payments"],
    });
    expect(mocks.chargesList).toHaveBeenCalledWith({
      customer: "cus_1",
      limit: 100,
      expand: ["data.refunds"],
    });
    expect(mocks.refundsCreate).toHaveBeenCalledWith(
      {
        charge: "ch_1",
        amount: 5_310,
        metadata: { reason: "contract_withdrawal", withdrawal_request_id: REQUEST_ID },
      },
      { idempotencyKey: `immojudis-withdrawal-${REQUEST_ID}` },
    );
  });

  it("does not refund a second time when the same withdrawal is run again (C9)", async () => {
    mocks.chargesList.mockResolvedValue({
      data: [
        charge("ch_1", "pi_latest", {
          amount_refunded: 5_310,
          refunds: [{ ...withdrawalRefund, amount: 5_310 }],
        }),
      ],
      has_more: false,
    });

    // Two days later: Stripe's 24-hour idempotency key no longer protects the call.
    const result = await run("full", "2026-10-06T00:00:00.000Z");

    expect(result.refundedCents).toBe(0);
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(mocks.updatePrivacyRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          operatorNotes: expect.stringContaining("re_1 déjà émis"),
        }),
      }),
    );
  });

  it("full, puis relance avec une charge ancienne : aucun nouveau remboursement (C6)", async () => {
    // Première exécution en mode `full` : la charge de la dernière facture est entièrement
    // remboursée (`refunded: true`). Le client a aussi une charge plus ancienne, payée et intacte.
    mocks.chargesList.mockResolvedValue({
      data: [
        charge("ch_latest", "pi_latest", {
          refunded: true,
          amount_refunded: 5_900,
          refunds: [withdrawalRefund],
        }),
        charge("ch_old", "pi_old"),
      ],
      has_more: false,
    });

    const result = await run("full", "2026-10-06T00:00:00.000Z");

    expect(result.refundedCents).toBe(0);
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
  });

  it("finds the refund of this request on any charge of the customer, not only the latest", async () => {
    // Remboursement de la demande posé sur une autre charge (émis à la main, ou avant une nouvelle
    // facture) : la relance n'en émet pas un second sur la dernière facture.
    mocks.chargesList.mockResolvedValue({
      data: [
        charge("ch_latest", "pi_latest"),
        charge("ch_old", "pi_old", { refunds: [withdrawalRefund] }),
      ],
      has_more: false,
    });

    const result = await run("full", "2026-10-06T00:00:00.000Z");

    expect(result.refundedCents).toBe(0);
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
  });

  it("refunds the charge of the latest invoice, never an older one listed first", async () => {
    mocks.chargesList.mockResolvedValue({
      data: [charge("ch_old", "pi_old"), charge("ch_latest", "pi_latest")],
      has_more: false,
    });

    const result = await run("full", "2026-10-04T00:00:00.000Z");

    expect(result.refundedCents).toBe(5_900);
    expect(mocks.refundsCreate).toHaveBeenCalledTimes(1);
    expect(mocks.refundsCreate.mock.calls[0][0]).toMatchObject({ charge: "ch_latest" });
  });

  it("refunds nothing when the latest invoice collected nothing (trial)", async () => {
    mocks.subscriptionsRetrieve.mockResolvedValue(subscription(null));
    mocks.chargesList.mockResolvedValue({ data: [charge("ch_old", "pi_old")], has_more: false });

    const result = await run("full", "2026-10-04T00:00:00.000Z");

    expect(result.refundedCents).toBe(0);
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
  });

  it("refuses to close when a paid latest invoice has no matching charge", async () => {
    // Abonnement encore actif : rien n'est résilié tant que la lecture n'est pas complète.
    mocks.subscriptionsRetrieve.mockResolvedValue({
      ...subscription("pi_latest"),
      status: "active",
    });
    mocks.chargesList.mockResolvedValue({ data: [charge("ch_old", "pi_old")], has_more: false });

    await expect(run("full", "2026-10-04T00:00:00.000Z")).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("in_latest introuvable"),
    });
    expect(mocks.subscriptionsCancel).not.toHaveBeenCalled();
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(mocks.updatePrivacyRequest).not.toHaveBeenCalled();
  });

  it("refuses to run when the customer has more charges than one page holds", async () => {
    mocks.subscriptionsRetrieve.mockResolvedValue({
      ...subscription("pi_latest"),
      status: "active",
    });
    mocks.chargesList.mockResolvedValue({
      data: [charge("ch_latest", "pi_latest")],
      has_more: true,
    });

    await expect(run("full", "2026-10-04T00:00:00.000Z")).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Plus de 100 paiements"),
    });
    expect(mocks.subscriptionsCancel).not.toHaveBeenCalled();
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(mocks.updatePrivacyRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["another request type", { request_type: "erasure" }, "pas une rétractation"],
    ["a closed request", { status: "completed" }, "déjà clôturée"],
    ["a request without an account", { user_id: null }, "aucun compte"],
  ])("refuses %s with a 409, before any Stripe call", async (_label, override, message) => {
    mocks.from.mockImplementation(() =>
      chain({
        data: {
          id: REQUEST_ID,
          request_type: "contract_withdrawal",
          status: "in_progress",
          user_id: USER_ID,
          ...override,
        },
        error: null,
      }),
    );

    await expect(
      executeContractWithdrawal({
        auth,
        input: { requestId: REQUEST_ID, refundMode: "full", confirm: true },
      }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining(message) });
    expect(mocks.subscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
  });
});
