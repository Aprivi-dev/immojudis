import "server-only";
import type Stripe from "stripe";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import {
  analysisSubscriptionPriceIds,
  getStripe,
  stripeAccessPeriodEndIso,
  stripeSubscriptionStatusToPlanStatus,
} from "@/lib/billing";
import { isPlanPeriodActive } from "@/lib/plans";

/**
 * Rapprochement en LECTURE SEULE entre les abonnements Stripe et les droits en base.
 *
 * Il signale les écarts (un client qui paie sans accès, un accès sans abonnement payant, un Price
 * inconnu, un compte qui ne correspond pas) et ne corrige rien : ni Stripe ni la base ne sont
 * modifiés. La correction reste une décision humaine (portail Stripe, attribution admin).
 *
 * Les droits accordés à la main (ligne sans identifiant d'abonnement Stripe) sont hors périmètre.
 */
type SubscriptionRow = Pick<
  Database["public"]["Tables"]["user_subscriptions"]["Row"],
  | "user_id"
  | "plan_code"
  | "status"
  | "current_period_end"
  | "stripe_customer_id"
  | "stripe_subscription_id"
>;

export type StripeSubscriptionView = {
  id: string;
  customerId: string | null;
  userId: string | null;
  stripeStatus: string;
  /** État converti comme le webhook le fait (`stripeSubscriptionStatusToPlanStatus`). */
  planStatus: string;
  currentPeriodEnd: string | null;
  priceId: string | null;
};

export type BillingDiscrepancyKind =
  /** Stripe facture un abonnement qui ouvre l'accès, aucune ligne ne le porte en base. */
  | "stripe_access_without_row"
  /** Stripe facture un abonnement qui ouvre l'accès, la base n'ouvre pas l'accès. */
  | "stripe_access_database_closed"
  /** La base ouvre l'accès, l'abonnement Stripe n'en ouvre plus ou n'existe plus. */
  | "database_access_stripe_closed"
  | "database_access_stripe_missing"
  /** Le Price de l'abonnement n'est dans aucune liste de l'offre Analyse. */
  | "unknown_price"
  /** Le compte indiqué par Stripe n'est pas celui de la ligne en base. */
  | "user_mismatch";

export type BillingDiscrepancy = {
  kind: BillingDiscrepancyKind;
  stripeSubscriptionId: string | null;
  userId: string | null;
  detail: string;
};

const ACCESS_STRIPE_STATUSES = new Set(["trialing", "active", "past_due"]);

export function stripeSubscriptionView(subscription: Stripe.Subscription): StripeSubscriptionView {
  const planStatus = stripeSubscriptionStatusToPlanStatus(subscription.status);
  const customer = subscription.customer;
  return {
    id: subscription.id,
    customerId: typeof customer === "string" ? customer : (customer?.id ?? null),
    userId: subscription.metadata?.user_id || null,
    stripeStatus: subscription.status,
    planStatus,
    currentPeriodEnd: stripeAccessPeriodEndIso(subscription, planStatus),
    priceId: subscription.items.data[0]?.price?.id ?? null,
  };
}

/** Pur : compare les deux côtés, sans accès réseau ni écriture. */
export function compareStripeWithDatabase({
  stripeSubscriptions,
  rows,
  acceptedPriceIds,
  now = new Date(),
}: {
  stripeSubscriptions: StripeSubscriptionView[];
  rows: SubscriptionRow[];
  acceptedPriceIds: string[];
  now?: Date;
}): BillingDiscrepancy[] {
  const discrepancies: BillingDiscrepancy[] = [];
  const rowsBySubscription = new Map(
    rows.flatMap((row) =>
      row.stripe_subscription_id ? [[row.stripe_subscription_id, row] as const] : [],
    ),
  );
  const rowsByCustomer = new Map(
    rows.flatMap((row) => (row.stripe_customer_id ? [[row.stripe_customer_id, row] as const] : [])),
  );
  const stripeById = new Map(stripeSubscriptions.map((item) => [item.id, item]));

  for (const subscription of stripeSubscriptions) {
    if (!ACCESS_STRIPE_STATUSES.has(subscription.stripeStatus)) continue;
    const row = rowsBySubscription.get(subscription.id);
    const priceKnown =
      acceptedPriceIds.length === 0 ||
      !subscription.priceId ||
      acceptedPriceIds.includes(subscription.priceId);
    if (!priceKnown) {
      discrepancies.push({
        kind: "unknown_price",
        stripeSubscriptionId: subscription.id,
        userId: row?.user_id ?? subscription.userId,
        detail: `Price ${subscription.priceId} absent de STRIPE_ANALYSIS_PRICE_ID et STRIPE_ANALYSIS_LEGACY_PRICE_IDS : l'accès est refusé à ce client.`,
      });
    }
    if (!row) {
      const sameCustomer = subscription.customerId
        ? rowsByCustomer.get(subscription.customerId)
        : undefined;
      discrepancies.push({
        kind: "stripe_access_without_row",
        stripeSubscriptionId: subscription.id,
        userId: sameCustomer?.user_id ?? subscription.userId,
        detail: sameCustomer
          ? `La ligne du compte porte l'abonnement ${sameCustomer.stripe_subscription_id ?? "(aucun)"}, pas celui-ci.`
          : "Aucune ligne en base pour cet abonnement.",
      });
      continue;
    }
    if (subscription.userId && subscription.userId !== row.user_id) {
      discrepancies.push({
        kind: "user_mismatch",
        stripeSubscriptionId: subscription.id,
        userId: row.user_id,
        detail: `Stripe indique le compte ${subscription.userId}, la base le compte ${row.user_id}.`,
      });
    }
    if (
      priceKnown &&
      (row.plan_code !== "analyse" || !isPlanPeriodActive(row.status, row.current_period_end, now))
    ) {
      discrepancies.push({
        kind: "stripe_access_database_closed",
        stripeSubscriptionId: subscription.id,
        userId: row.user_id,
        detail: `Stripe : ${subscription.stripeStatus}. Base : ${row.plan_code} / ${row.status}, fin de période ${row.current_period_end ?? "non définie"}.`,
      });
    }
  }

  for (const row of rows) {
    const subscriptionId = row.stripe_subscription_id;
    if (!subscriptionId || row.plan_code !== "analyse") continue;
    if (!isPlanPeriodActive(row.status, row.current_period_end, now)) continue;
    const subscription = stripeById.get(subscriptionId);
    if (!subscription) {
      discrepancies.push({
        kind: "database_access_stripe_missing",
        stripeSubscriptionId: subscriptionId,
        userId: row.user_id,
        detail: "La base ouvre l'accès, Stripe ne connaît pas (ou plus) cet abonnement.",
      });
    } else if (!ACCESS_STRIPE_STATUSES.has(subscription.stripeStatus)) {
      discrepancies.push({
        kind: "database_access_stripe_closed",
        stripeSubscriptionId: subscriptionId,
        userId: row.user_id,
        detail: `La base ouvre l'accès (${row.status}), l'abonnement Stripe est ${subscription.stripeStatus}.`,
      });
    }
  }

  return discrepancies;
}

/** Pages de 100 abonnements lues au plus : au-delà, le rapport le signale (`truncated`). */
const MAX_STRIPE_PAGES = 50;

async function listStripeSubscriptions(): Promise<{
  subscriptions: StripeSubscriptionView[];
  truncated: boolean;
}> {
  const stripe = getStripe();
  const subscriptions: StripeSubscriptionView[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_STRIPE_PAGES; page += 1) {
    const result = await stripe.subscriptions.list({
      status: "all",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    subscriptions.push(...result.data.map(stripeSubscriptionView));
    startingAfter = result.data.at(-1)?.id;
    if (!result.has_more || !startingAfter) return { subscriptions, truncated: false };
  }
  return { subscriptions, truncated: true };
}

export type BillingReconciliationReport = {
  checkedAt: string;
  stripeSubscriptionCount: number;
  databaseRowCount: number;
  /** Faux : la liste Stripe a été lue en entier. */
  truncated: boolean;
  discrepancies: BillingDiscrepancy[];
};

export async function reconcileBillingReadOnly(
  authToken: string,
): Promise<BillingReconciliationReport> {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) {
    throw new Error("Forbidden: ce compte n'a pas les droits administrateur Immojudis.");
  }
  const [stripeResult, rowsResult] = await Promise.all([
    listStripeSubscriptions(),
    supabaseAdmin
      .from("user_subscriptions")
      .select(
        "user_id,plan_code,status,current_period_end,stripe_customer_id,stripe_subscription_id",
      )
      .not("stripe_subscription_id", "is", null),
  ]);
  if (rowsResult.error) throw rowsResult.error;
  const rows = (rowsResult.data ?? []) as SubscriptionRow[];
  return {
    checkedAt: new Date().toISOString(),
    stripeSubscriptionCount: stripeResult.subscriptions.length,
    databaseRowCount: rows.length,
    truncated: stripeResult.truncated,
    discrepancies: compareStripeWithDatabase({
      stripeSubscriptions: stripeResult.subscriptions,
      rows,
      acceptedPriceIds: analysisSubscriptionPriceIds(),
    }),
  };
}
