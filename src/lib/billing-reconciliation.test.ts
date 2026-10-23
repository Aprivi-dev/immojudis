import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("stripe", () => ({ default: class FakeStripe {} }));

import {
  compareStripeWithDatabase,
  stripeSubscriptionView,
  type StripeSubscriptionView,
} from "@/lib/billing-reconciliation";
import type Stripe from "stripe";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const FUTURE = "2026-12-10T12:00:00.000Z";
const PAST = "2026-10-01T12:00:00.000Z";

const stripeSub = (overrides: Partial<StripeSubscriptionView> = {}): StripeSubscriptionView => ({
  id: "sub_1",
  customerId: "cus_1",
  userId: "user-1",
  stripeStatus: "active",
  planStatus: "active",
  currentPeriodEnd: FUTURE,
  priceId: "price_a",
  ...overrides,
});

const row = (overrides: Record<string, unknown> = {}) => ({
  user_id: "user-1",
  plan_code: "analyse",
  status: "active",
  current_period_end: FUTURE,
  stripe_customer_id: "cus_1",
  stripe_subscription_id: "sub_1",
  ...overrides,
});

const compare = (
  stripeSubscriptions: StripeSubscriptionView[],
  rows: ReturnType<typeof row>[],
  acceptedPriceIds = ["price_a"],
) =>
  compareStripeWithDatabase({
    stripeSubscriptions,
    rows: rows as never,
    acceptedPriceIds,
    now: NOW,
  });

describe("rapprochement Stripe / base (lecture seule)", () => {
  it("ne signale rien quand les deux côtés concordent", () => {
    expect(compare([stripeSub()], [row()])).toEqual([]);
  });

  it("ignore un abonnement Stripe terminé et un droit accordé à la main", () => {
    expect(
      compare(
        [stripeSub({ stripeStatus: "canceled", planStatus: "cancelled" })],
        [
          row({ status: "cancelled" }),
          row({ user_id: "admin-grant", stripe_subscription_id: null }),
        ],
      ),
    ).toEqual([]);
  });

  it("signale un client qui paie sans ligne en base", () => {
    const result = compare([stripeSub()], []);
    expect(result).toEqual([
      expect.objectContaining({
        kind: "stripe_access_without_row",
        stripeSubscriptionId: "sub_1",
        userId: "user-1",
      }),
    ]);
  });

  it("signale une ligne qui porte un autre abonnement du même client", () => {
    const result = compare(
      [stripeSub()],
      [row({ stripe_subscription_id: "sub_other", status: "cancelled" })],
    );
    expect(result[0]).toMatchObject({
      kind: "stripe_access_without_row",
      userId: "user-1",
      detail: expect.stringContaining("sub_other"),
    });
  });

  it("signale un client qui paie alors que la base ferme l'accès", () => {
    expect(compare([stripeSub()], [row({ status: "paused" })])).toEqual([
      expect.objectContaining({ kind: "stripe_access_database_closed", userId: "user-1" }),
    ]);
    expect(compare([stripeSub()], [row({ current_period_end: PAST })])).toEqual([
      expect.objectContaining({ kind: "stripe_access_database_closed" }),
    ]);
    expect(compare([stripeSub()], [row({ plan_code: "decouverte" })])).toEqual([
      expect.objectContaining({ kind: "stripe_access_database_closed" }),
    ]);
  });

  it("signale un accès en base dont l'abonnement Stripe est fermé ou inconnu", () => {
    expect(compare([stripeSub({ stripeStatus: "unpaid", planStatus: "paused" })], [row()])).toEqual(
      [expect.objectContaining({ kind: "database_access_stripe_closed" })],
    );
    expect(compare([], [row()])).toEqual([
      expect.objectContaining({ kind: "database_access_stripe_missing" }),
    ]);
  });

  it("signale un Price hors des listes de l'offre Analyse (accès refusé au client)", () => {
    const result = compare(
      [stripeSub({ priceId: "price_new" })],
      [row({ plan_code: "decouverte", status: "active" })],
    );
    expect(result).toEqual([expect.objectContaining({ kind: "unknown_price" })]);
    expect(
      compare([stripeSub({ priceId: "price_new" })], [row()], ["price_a", "price_new"]),
    ).toEqual([]);
  });

  it("signale un compte qui ne correspond pas", () => {
    expect(compare([stripeSub({ userId: "user-2" })], [row()])).toEqual([
      expect.objectContaining({ kind: "user_mismatch", userId: "user-1" }),
    ]);
  });

  it("ne modifie rien : le résultat est une simple liste d'écarts", () => {
    const rows = [row({ status: "paused" })];
    const before = JSON.stringify(rows);
    compare([stripeSub()], rows);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe("stripeSubscriptionView", () => {
  it("convertit l'état comme le webhook et lit le Price, le client et le compte", () => {
    const view = stripeSubscriptionView({
      id: "sub_9",
      status: "unpaid",
      customer: { id: "cus_9" },
      metadata: { user_id: "user-9" },
      items: { data: [{ current_period_end: 1_900_000_000, price: { id: "price_z" } }] },
    } as unknown as Stripe.Subscription);
    expect(view).toMatchObject({
      id: "sub_9",
      customerId: "cus_9",
      userId: "user-9",
      stripeStatus: "unpaid",
      planStatus: "paused",
      priceId: "price_z",
    });
  });
});
