import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  subscriptionsRetrieve: vi.fn(),
  subscriptionsCancel: vi.fn(),
  chargesList: vi.fn(),
  refundsList: vi.fn(),
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
    refunds: { list: mocks.refundsList, create: mocks.refundsCreate },
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
    mocks.subscriptionsRetrieve.mockResolvedValue({
      id: "sub_1",
      status: "canceled",
      items: { data: [{ current_period_start: periodStart, current_period_end: periodEnd }] },
    });
    mocks.updatePrivacyRequest.mockImplementation(async ({ input }) => input);
  });

  it("tags the refund with the request so that a retry can find it", async () => {
    mocks.chargesList.mockResolvedValue({
      data: [{ id: "ch_1", paid: true, refunded: false, amount: 5_900, amount_refunded: 0 }],
    });
    mocks.refundsList.mockResolvedValue({ data: [] });

    const result = await executeContractWithdrawal({
      auth,
      input: { requestId: REQUEST_ID, refundMode: "prorata" },
      now: new Date("2026-10-04T00:00:00.000Z"),
    });

    expect(result.refundedCents).toBe(5_310);
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
      data: [{ id: "ch_1", paid: true, refunded: false, amount: 5_900, amount_refunded: 5_310 }],
    });
    mocks.refundsList.mockResolvedValue({
      data: [
        {
          id: "re_1",
          amount: 5_310,
          status: "succeeded",
          metadata: { reason: "contract_withdrawal", withdrawal_request_id: REQUEST_ID },
        },
      ],
    });

    const result = await executeContractWithdrawal({
      auth,
      input: { requestId: REQUEST_ID, refundMode: "full" },
      // Two days later: Stripe's 24-hour idempotency key no longer protects the call.
      now: new Date("2026-10-06T00:00:00.000Z"),
    });

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
      executeContractWithdrawal({ auth, input: { requestId: REQUEST_ID, refundMode: "full" } }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining(message) });
    expect(mocks.subscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
  });
});
