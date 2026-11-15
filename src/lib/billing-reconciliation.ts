import "server-only";
import { assertAdminAuth } from "@/lib/admin-auth.server";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { ANALYSIS_RECURRING_PRICE_CENTS } from "@/lib/analysis-offer";
import { analysisPriceId } from "@/lib/analysis-checkout-readiness";
import {
  analysisSubscriptionPriceIds,
  getStripe,
  SALE_UNLOCK_PAYMENT_PURPOSE,
  stripeAccessPeriodEndIso,
  stripeSubscriptionStatusToPlanStatus,
} from "@/lib/billing";
import { saleUnlockPriceId } from "@/lib/sale-unlock-checkout-readiness";
import { serverEnv } from "@/lib/env";
import { isPlanPeriodActive } from "@/lib/plans";

/**
 * Rapprochement en LECTURE SEULE entre les abonnements Stripe et les droits en base.
 *
 * Il signale les écarts (un client qui paie sans accès, un accès sans abonnement payant, un Price
 * inconnu, un compte qui ne correspond pas) et ne corrige rien : ni Stripe ni la base ne sont
 * modifiés. La correction reste une décision humaine (portail Stripe, attribution admin).
 *
 * Les droits accordés à la main (ligne sans identifiant d'abonnement Stripe) sont hors périmètre.
 *
 * Achats à l'unité (lot 3), quand leur Price est configuré : une session `sale_unlock` payée chez
 * Stripe sans achat payé en base, et un achat déduit d'un premier mois d'abonnement puis remboursé
 * (ou litige perdu) : le client aurait la déduction et le remboursement.
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
  /** Montant unitaire du Price en centimes (`null` : inconnu ou tarification à paliers). */
  priceAmountCents?: number | null;
};

type BillingDiscrepancyKind =
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
  | "user_mismatch"
  /** Session d'achat à l'unité payée chez Stripe, sans achat payé en base (déblocage non accordé). */
  | "sale_unlock_paid_without_purchase"
  /** Achat à l'unité déduit d'un premier mois d'abonnement, puis remboursé ou litige perdu. */
  | "sale_unlock_deducted_then_refunded";

export type BillingDiscrepancy = {
  kind: BillingDiscrepancyKind;
  stripeSubscriptionId: string | null;
  userId: string | null;
  detail: string;
  /** Session Checkout en cause (achats à l'unité). */
  stripeCheckoutSessionId?: string | null;
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
    priceAmountCents: subscription.items.data[0]?.price?.unit_amount ?? null,
  };
}

/** Pur : compare les deux côtés, sans accès réseau ni écriture. */
export function compareStripeWithDatabase({
  stripeSubscriptions,
  rows,
  acceptedPriceIds,
  currentPriceId = null,
  listComplete = true,
  now = new Date(),
}: {
  stripeSubscriptions: StripeSubscriptionView[];
  rows: SubscriptionRow[];
  acceptedPriceIds: string[];
  /** Price courant (`STRIPE_ANALYSIS_PRICE_ID`) : son montant doit valoir 59 € (comme `isRecognisedAnalysisPrice`). */
  currentPriceId?: string | null;
  /** Faux quand la liste Stripe est tronquée : un abonnement absent de la liste n'est alors pas « inconnu de Stripe ». */
  listComplete?: boolean;
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
    // Fermé par défaut (n° 47), comme `isAnalysisSubscriptionPrice` : sans Price configuré ou sans
    // Price sur l'abonnement, rien n'est reconnu et l'écart est signalé.
    const priceKnown =
      Boolean(subscription.priceId) &&
      acceptedPriceIds.includes(subscription.priceId!) &&
      (subscription.priceId !== currentPriceId ||
        subscription.priceAmountCents === ANALYSIS_RECURRING_PRICE_CENTS);
    if (!priceKnown) {
      discrepancies.push({
        kind: "unknown_price",
        stripeSubscriptionId: subscription.id,
        userId: row?.user_id ?? subscription.userId,
        detail: `Price ${subscription.priceId ?? "(aucun)"} absent de STRIPE_ANALYSIS_PRICE_ID et STRIPE_ANALYSIS_LEGACY_PRICE_IDS : l'accès est refusé à ce client.`,
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
      // Liste tronquée : l'abonnement peut exister au-delà de la dernière page lue.
      if (!listComplete) continue;
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

/** Session Checkout d'achat à l'unité payée chez Stripe. */
export type SaleUnlockPaidSession = { id: string; userId: string | null };

/** Ligne de `sale_unlock_purchases` lue par le rapprochement. */
export type SaleUnlockPurchaseRow = {
  id: string;
  user_id: string;
  checkout_session_id: string | null;
  state: string;
  deducted_checkout_session_id: string | null;
};

/** États d'un achat dont le paiement a été enregistré (payé, puis éventuellement remboursé ou contesté). */
const RECORDED_PAYMENT_STATES = new Set(["paid", "refunded", "disputed", "dispute_lost"]);

/** Pur : les achats à l'unité, sans accès réseau ni écriture. */
export function compareSaleUnlockPurchases({
  paidSessions,
  purchases,
}: {
  paidSessions: SaleUnlockPaidSession[];
  /** Achats des sessions de `paidSessions`, et achats déduits puis remboursés ou perdus. */
  purchases: SaleUnlockPurchaseRow[];
}): BillingDiscrepancy[] {
  const discrepancies: BillingDiscrepancy[] = [];
  const recordedSessions = new Set(
    purchases
      .filter((purchase) => RECORDED_PAYMENT_STATES.has(purchase.state))
      .flatMap((purchase) => (purchase.checkout_session_id ? [purchase.checkout_session_id] : [])),
  );
  for (const session of paidSessions) {
    if (recordedSessions.has(session.id)) continue;
    discrepancies.push({
      kind: "sale_unlock_paid_without_purchase",
      stripeSubscriptionId: null,
      stripeCheckoutSessionId: session.id,
      userId: session.userId,
      detail: `Session ${session.id} payée chez Stripe, aucun achat payé en base : le déblocage n'a pas été accordé (rejouer l'événement depuis Stripe).`,
    });
  }
  for (const purchase of purchases) {
    if (!purchase.deducted_checkout_session_id) continue;
    if (purchase.state !== "refunded" && purchase.state !== "dispute_lost") continue;
    discrepancies.push({
      kind: "sale_unlock_deducted_then_refunded",
      stripeSubscriptionId: null,
      stripeCheckoutSessionId: purchase.checkout_session_id,
      userId: purchase.user_id,
      detail: `Achat ${purchase.id} déduit du premier mois (session ${purchase.deducted_checkout_session_id}) puis ${purchase.state === "refunded" ? "remboursé" : "perdu en litige"}.`,
    });
  }
  return discrepancies;
}

/** Sessions d'achat lues : celles des 35 derniers jours (une session expire en 31 minutes). */
const SALE_UNLOCK_SESSION_WINDOW_SECONDS = 35 * 86_400;
/**
 * Une session payée depuis moins de 2 heures peut attendre son webhook : elle n'est pas encore un
 * écart. Une session vit 31 minutes au plus, son paiement est donc antérieur à sa création + 31 min.
 */
const SALE_UNLOCK_WEBHOOK_GRACE_SECONDS = 2 * 3_600;

async function listPaidSaleUnlockSessions(): Promise<{
  sessions: SaleUnlockPaidSession[];
  truncated: boolean;
}> {
  const stripe = getStripe();
  const now = Math.floor(Date.now() / 1000);
  const sessions: SaleUnlockPaidSession[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_STRIPE_PAGES; page += 1) {
    const result = await stripe.checkout.sessions.list({
      status: "complete",
      created: {
        gte: now - SALE_UNLOCK_SESSION_WINDOW_SECONDS,
        lte: now - SALE_UNLOCK_WEBHOOK_GRACE_SECONDS,
      },
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const session of result.data) {
      if (session.metadata?.purpose !== SALE_UNLOCK_PAYMENT_PURPOSE) continue;
      if (session.payment_status !== "paid") continue;
      sessions.push({ id: session.id, userId: session.metadata?.user_id || null });
    }
    startingAfter = result.data.at(-1)?.id;
    if (!result.has_more || !startingAfter) return { sessions, truncated: false };
  }
  return { sessions, truncated: true };
}

const SALE_UNLOCK_PURCHASE_COLUMNS =
  "id,user_id,checkout_session_id,state,deducted_checkout_session_id";

/** Achats des sessions payées, et achats déduits puis remboursés ou perdus (client de service). */
async function readSaleUnlockPurchases(sessionIds: string[]): Promise<SaleUnlockPurchaseRow[]> {
  // Table de la migration 20261122100000, pas encore dans les types générés.
  const client = supabaseAdmin as unknown as SupabaseClient;
  const rows: SaleUnlockPurchaseRow[] = [];
  for (let index = 0; index < sessionIds.length; index += 100) {
    const { data, error } = await client
      .from("sale_unlock_purchases")
      .select(SALE_UNLOCK_PURCHASE_COLUMNS)
      .in("checkout_session_id", sessionIds.slice(index, index + 100));
    if (error) throw error;
    rows.push(...((data ?? []) as SaleUnlockPurchaseRow[]));
  }
  const { data, error } = await client
    .from("sale_unlock_purchases")
    .select(SALE_UNLOCK_PURCHASE_COLUMNS)
    .not("deducted_checkout_session_id", "is", null)
    .in("state", ["refunded", "dispute_lost"]);
  if (error) throw error;
  rows.push(...((data ?? []) as SaleUnlockPurchaseRow[]));
  return rows;
}

async function reconcileSaleUnlockPurchases(): Promise<{
  discrepancies: BillingDiscrepancy[];
  truncated: boolean;
}> {
  // Pas de Price d'achat à l'unité : la vente n'a jamais été ouverte, il n'y a rien à rapprocher.
  if (!saleUnlockPriceId()) return { discrepancies: [], truncated: false };
  const { sessions, truncated } = await listPaidSaleUnlockSessions();
  const purchases = await readSaleUnlockPurchases(sessions.map((session) => session.id));
  return {
    discrepancies: compareSaleUnlockPurchases({ paidSessions: sessions, purchases }),
    truncated,
  };
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
  await assertAdminAuth(authToken);
  return reconcileBillingNow();
}

/** Le rapprochement sans contrôle d'accès : réservé à la tâche planifiée et à `reconcileBillingReadOnly`. */
async function reconcileBillingNow(): Promise<BillingReconciliationReport> {
  const [stripeResult, rowsResult, saleUnlocks] = await Promise.all([
    listStripeSubscriptions(),
    supabaseAdmin
      .from("user_subscriptions")
      .select(
        "user_id,plan_code,status,current_period_end,stripe_customer_id,stripe_subscription_id",
      )
      .not("stripe_subscription_id", "is", null),
    reconcileSaleUnlockPurchases(),
  ]);
  if (rowsResult.error) throw rowsResult.error;
  const rows = (rowsResult.data ?? []) as SubscriptionRow[];
  return {
    checkedAt: new Date().toISOString(),
    stripeSubscriptionCount: stripeResult.subscriptions.length,
    databaseRowCount: rows.length,
    truncated: stripeResult.truncated || saleUnlocks.truncated,
    discrepancies: [
      ...compareStripeWithDatabase({
        stripeSubscriptions: stripeResult.subscriptions,
        rows,
        acceptedPriceIds: analysisSubscriptionPriceIds(),
        currentPriceId: analysisPriceId() ?? null,
        listComplete: !stripeResult.truncated,
      }),
      ...saleUnlocks.discrepancies,
    ],
  };
}

/** Écarts nommés dans l'alerte : le détail complet reste dans le rapport de la tâche (journal des exécutions). */
const ALERT_SAMPLE_SIZE = 10;

/** Stripe est-il configuré pour le rapprochement : clé secrète et au moins un Price de l'offre ? */
export function billingReconciliationConfigured(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): boolean {
  return Boolean(serverEnv(env).stripe.secretKey) && analysisSubscriptionPriceIds(env).length > 0;
}

/**
 * Rapprochement quotidien (n° 48), lancé par `/api/cron/billing-reconciliation` sous
 * `runMonitoredCron`. Lecture seule côté Stripe et côté abonnements : il ne corrige rien. Un écart
 * ouvre (ou maintient) une alerte opérationnelle, livrée par le canal d'alerte existant à la
 * prochaine passe de `operational-health` ; un rapprochement sans écart la referme (la base ne la
 * résout qu'après deux heures calmes). Sans Stripe configuré (clé ou Price absent), la tâche ne fait
 * rien et n'alerte pas.
 */
export async function runBillingReconciliationJob(): Promise<Record<string, unknown>> {
  if (!billingReconciliationConfigured()) return { skipped: "stripe_not_configured" };
  const report = await reconcileBillingNow();
  const kinds: Record<string, number> = {};
  for (const discrepancy of report.discrepancies) {
    kinds[discrepancy.kind] = (kinds[discrepancy.kind] ?? 0) + 1;
  }
  const active = report.discrepancies.length > 0;
  const { error } = await supabaseAdmin.rpc("sync_billing_reconciliation_alert", {
    p_active: active,
    p_details: {
      checked_at: report.checkedAt,
      discrepancy_count: report.discrepancies.length,
      kinds,
      truncated: report.truncated,
      stripe_subscription_count: report.stripeSubscriptionCount,
      database_row_count: report.databaseRowCount,
      // Identifiants d'abonnement Stripe et de compte seulement : ni email ni nom.
      sample: report.discrepancies.slice(0, ALERT_SAMPLE_SIZE).map((discrepancy) => ({
        kind: discrepancy.kind,
        subscription: discrepancy.stripeSubscriptionId,
        ...(discrepancy.stripeCheckoutSessionId
          ? { session: discrepancy.stripeCheckoutSessionId }
          : {}),
        user: discrepancy.userId,
      })),
    },
  });
  // Un écart que l'alerte ne peut pas porter ne doit pas rester silencieux : la tâche échoue.
  if (error) {
    throw new Error(error.message || "Alerte de rapprochement Stripe impossible à écrire.");
  }
  return {
    stripeSubscriptionCount: report.stripeSubscriptionCount,
    databaseRowCount: report.databaseRowCount,
    truncated: report.truncated,
    discrepancyCount: report.discrepancies.length,
    kinds,
    alert: active ? "open" : "clear",
  };
}
