import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  rows: vi.fn(),
  subscriptionsList: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: mocks.rpc,
    from: () => ({
      select: () => ({ not: async () => mocks.rows() }),
    }),
  },
}));
vi.mock("stripe", () => ({
  default: class FakeStripe {
    subscriptions = { list: mocks.subscriptionsList };
  },
}));

import {
  billingReconciliationConfigured,
  runBillingReconciliationJob,
} from "@/lib/billing-reconciliation";

const FUTURE = new Date(Date.now() + 20 * 86_400_000).toISOString();
const PERIOD_END = Math.floor(Date.now() / 1000) + 20 * 86_400;

function stripeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    metadata: { user_id: "user-1" },
    items: {
      data: [{ current_period_end: PERIOD_END, price: { id: "price_a", unit_amount: 5_900 } }],
    },
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    user_id: "user-1",
    plan_code: "analyse",
    status: "active",
    current_period_end: FUTURE,
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_1",
    ...overrides,
  };
}

describe("rapprochement Stripe quotidien", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.rows.mockReset();
    mocks.subscriptionsList.mockReset();
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_reconcile");
    vi.stubEnv("STRIPE_ANALYSIS_PRICE_ID", "price_a");
    vi.stubEnv("STRIPE_ANALYSIS_LEGACY_PRICE_IDS", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("ne s'exécute que si Stripe est configuré (clé secrète et Price de l'offre)", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect(billingReconciliationConfigured()).toBe(false);
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_reconcile");
    vi.stubEnv("STRIPE_ANALYSIS_PRICE_ID", "");
    expect(billingReconciliationConfigured()).toBe(false);

    await expect(runBillingReconciliationJob()).resolves.toEqual({
      skipped: "stripe_not_configured",
    });
    expect(mocks.subscriptionsList).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("referme l'alerte quand Stripe et la base concordent", async () => {
    mocks.subscriptionsList.mockResolvedValue({ data: [stripeSubscription()], has_more: false });
    mocks.rows.mockResolvedValue({ data: [row()], error: null });

    const result = await runBillingReconciliationJob();

    expect(result).toMatchObject({ discrepancyCount: 0, alert: "clear" });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "sync_billing_reconciliation_alert",
      expect.objectContaining({ p_active: false }),
    );
  });

  it("ouvre l'alerte dès qu'un écart apparaît, sans rien corriger", async () => {
    // Stripe facture, la base n'ouvre pas l'accès.
    mocks.subscriptionsList.mockResolvedValue({ data: [stripeSubscription()], has_more: false });
    mocks.rows.mockResolvedValue({ data: [row({ status: "paused" })], error: null });

    const result = await runBillingReconciliationJob();

    expect(result).toMatchObject({
      discrepancyCount: 1,
      alert: "open",
      kinds: { stripe_access_database_closed: 1 },
    });
    const [name, args] = mocks.rpc.mock.calls[0];
    expect(name).toBe("sync_billing_reconciliation_alert");
    expect(args).toMatchObject({
      p_active: true,
      p_details: {
        discrepancy_count: 1,
        sample: [{ kind: "stripe_access_database_closed", subscription: "sub_1", user: "user-1" }],
      },
    });
    // Seule l'alerte est écrite : aucun autre appel d'écriture.
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("signale un Price inconnu (et non plus accepté faute de configuration)", async () => {
    mocks.subscriptionsList.mockResolvedValue({
      data: [
        stripeSubscription({
          items: { data: [{ current_period_end: PERIOD_END, price: { id: "price_other" } }] },
        }),
      ],
      has_more: false,
    });
    mocks.rows.mockResolvedValue({ data: [row()], error: null });

    const result = await runBillingReconciliationJob();

    expect(result).toMatchObject({ alert: "open", kinds: { unknown_price: 1 } });
  });

  it("signale le Price courant à un autre montant que 59 €, comme l'ouverture des droits", async () => {
    mocks.subscriptionsList.mockResolvedValue({
      data: [
        stripeSubscription({
          items: {
            data: [
              { current_period_end: PERIOD_END, price: { id: "price_a", unit_amount: 4_900 } },
            ],
          },
        }),
      ],
      has_more: false,
    });
    mocks.rows.mockResolvedValue({ data: [row()], error: null });

    const result = await runBillingReconciliationJob();

    expect(result).toMatchObject({ alert: "open", kinds: { unknown_price: 1 } });
  });

  it("échoue quand l'alerte ne peut pas être écrite, pour que l'écart ne reste pas silencieux", async () => {
    mocks.subscriptionsList.mockResolvedValue({ data: [stripeSubscription()], has_more: false });
    mocks.rows.mockResolvedValue({ data: [row({ status: "paused" })], error: null });
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "function does not exist" } });

    await expect(runBillingReconciliationJob()).rejects.toThrow("function does not exist");
  });
});
