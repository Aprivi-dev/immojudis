import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { normalizePlanCode, type PlanCode, type PlanStatus } from "@/lib/plans";
import { resolveSiteOrigin } from "@/lib/site-url";
import {
  assertCommercialConfirmationReadiness,
  type CheckoutConsent,
  recordCommercialAcceptance,
  sendCommercialConfirmation,
} from "@/lib/commercial-acceptance";
import { assertPaidOfferLegalReadiness } from "@/lib/legal-documents";

type UserSubscriptionRow = Database["public"]["Tables"]["user_subscriptions"]["Row"];

export type BillingSessionResponse = {
  url: string;
};

export type StripeWebhookResult = {
  eventId: string;
  type: string;
  handled: boolean;
  duplicate?: boolean;
};

type StripeWebhookEventRpcClient = {
  rpc(
    name: "begin_stripe_webhook_event",
    args: { p_event_id: string; p_event_type: string; p_livemode: boolean },
  ): Promise<{ data: boolean | null; error: { message?: string } | null }>;
  rpc(
    name: "complete_stripe_webhook_event",
    args: { p_error_message: string | null; p_event_id: string; p_processing_status: string },
  ): Promise<{ data: null; error: { message?: string } | null }>;
};

type StripePaymentLifecycleState = "disputed" | "dispute_lost" | "cleared" | "refunded";
type StripeReconciledPlanStatus = "active" | "paused" | "cancelled" | "expired";

type StripePaymentLifecycleRpcClient = {
  rpc(
    name: "record_stripe_payment_state",
    args: {
      p_entitlement_status: StripeReconciledPlanStatus;
      p_event_created: number;
      p_event_id: string;
      p_event_type: string;
      p_payment_intent_id: string;
      p_revoke_immediately: boolean;
      p_state: StripePaymentLifecycleState;
      p_user_id: string;
    },
  ): Promise<{
    data: Array<{
      effective_state: string;
      entitlement_updated: boolean;
      recorded: boolean;
    }> | null;
    error: { message?: string } | null;
  }>;
  rpc(
    name: "grant_analysis_access_from_payment",
    args: {
      p_amount_total: number;
      p_checkout_session_id: string;
      p_currency: string;
      p_duration_days: number;
      p_event_created: number;
      p_event_id: string;
      p_paid_at: string;
      p_payment_intent_id: string;
      p_stripe_customer_id: string | null;
      p_user_id: string;
    },
  ): Promise<{
    data: Array<{ access_end: string | null; granted: boolean }> | null;
    error: { message?: string } | null;
  }>;
};

const STRIPE_API_VERSION = "2026-06-24.dahlia";
export const ANALYSIS_ACCESS_DAYS = 30;
export const ANALYSIS_PRICE_CENTS = 2_900;

let stripeClient: Stripe | undefined;

function stripeSecretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Stripe n'est pas configuré: STRIPE_SECRET_KEY manquant.");
  return key;
}

function stripeWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("Stripe webhook non configuré: STRIPE_WEBHOOK_SECRET manquant.");
  return secret;
}

export function getStripe(): Stripe {
  if (!stripeClient) {
    stripeClient = new Stripe(stripeSecretKey(), {
      apiVersion: STRIPE_API_VERSION,
      maxNetworkRetries: 2,
      typescript: true,
    });
  }

  return stripeClient;
}

export function resolveBillingOrigin(requestOrigin?: string | null): string {
  return resolveSiteOrigin(process.env, requestOrigin || "http://localhost:3000")!;
}

export async function createAnalyseCheckoutSession({
  auth,
  origin,
  consent,
  requestId,
  userAgent,
}: {
  auth: SupabaseAuthContext;
  origin?: string | null;
  consent: CheckoutConsent;
  requestId?: string | null;
  userAgent?: string | null;
}): Promise<BillingSessionResponse> {
  return createPlanCheckoutSession({
    auth,
    origin,
    plan: "analyse",
    consent,
    requestId,
    userAgent,
  });
}

export async function createPlanCheckoutSession({
  auth,
  origin,
  plan,
  consent,
  requestId,
  userAgent,
}: {
  auth: SupabaseAuthContext;
  origin?: string | null;
  plan: Exclude<PlanCode, "decouverte">;
  consent: CheckoutConsent;
  requestId?: string | null;
  userAgent?: string | null;
}): Promise<BillingSessionResponse> {
  assertPaidOfferLegalReadiness();
  assertCommercialConfirmationReadiness();
  const stripe = getStripe();
  const appOrigin = resolveBillingOrigin(origin);
  const customerId = await ensureStripeCustomer(auth);
  const acceptanceId = randomUUID();

  const session = await stripe.checkout.sessions.create(
    buildAnalysisCheckoutSessionParams({
      appOrigin,
      customerId,
      userId: auth.userId,
      acceptanceId,
    }),
  );

  if (!session.url) throw new Error("Session de paiement Stripe indisponible.");
  await recordCommercialAcceptance({
    acceptanceId,
    auth,
    consent,
    checkoutSessionId: session.id,
    checkoutCreatedAt: new Date(session.created * 1000).toISOString(),
    requestId: requestId ?? null,
    userAgent: userAgent ?? null,
  });
  return { url: session.url };
}

export function buildAnalysisCheckoutSessionParams({
  appOrigin,
  customerId,
  userId,
  acceptanceId,
}: {
  appOrigin: string;
  customerId: string;
  userId: string;
  acceptanceId?: string;
}): Stripe.Checkout.SessionCreateParams {
  return {
    mode: "payment",
    submit_type: "pay",
    customer: customerId,
    client_reference_id: userId,
    line_items: [
      {
        price_data: {
          currency: "eur",
          unit_amount: ANALYSIS_PRICE_CENTS,
          product_data: {
            name: "ImmoJudis Analyse — 30 jours",
            description:
              "Accès complet aux analyses, documents, risques, comparables et outils de décision pendant 30 jours.",
          },
        },
        quantity: 1,
      },
    ],
    locale: "fr",
    invoice_creation: {
      enabled: true,
      invoice_data: {
        description: "ImmoJudis Analyse — accès 30 jours, paiement unique",
      },
    },
    success_url: `${appOrigin}/accompagnement?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appOrigin}/accompagnement?checkout=cancelled`,
    metadata: {
      user_id: userId,
      plan_code: "analyse",
      access_duration_days: String(ANALYSIS_ACCESS_DAYS),
      billing_model: "one_time_30_days",
      ...(acceptanceId ? { commercial_acceptance_id: acceptanceId } : {}),
    },
    payment_intent_data: {
      metadata: {
        user_id: userId,
        plan_code: "analyse",
        access_duration_days: String(ANALYSIS_ACCESS_DAYS),
        ...(acceptanceId ? { commercial_acceptance_id: acceptanceId } : {}),
      },
    },
  };
}

export async function createBillingPortalSession({
  auth,
  origin,
}: {
  auth: SupabaseAuthContext;
  origin?: string | null;
}): Promise<BillingSessionResponse> {
  const stripe = getStripe();
  const appOrigin = resolveBillingOrigin(origin);
  const subscription = await getUserSubscription(auth);

  if (!subscription?.stripe_customer_id) {
    throw new Error("Aucun compte Stripe n'est encore associé à ce compte.");
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: subscription.stripe_customer_id,
    return_url: `${appOrigin}/accompagnement?billing=portal`,
    locale: "fr",
  });

  return { url: session.url };
}

export async function handleStripeWebhook({
  payload,
  signature,
}: {
  payload: string;
  signature: string | null;
}): Promise<StripeWebhookResult> {
  if (!signature) throw new Error("Signature Stripe manquante.");

  const stripe = getStripe();
  const event = stripe.webhooks.constructEvent(payload, signature, stripeWebhookSecret());
  const isNewEvent = await beginStripeWebhookEvent(event);
  if (!isNewEvent) {
    return { eventId: event.id, type: event.type, handled: true, duplicate: true };
  }

  try {
    let handled = false;
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        handled = await handleCheckoutCompleted(
          event.data.object as Stripe.Checkout.Session,
          event,
        );
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        handled = await syncStripeSubscription(event.data.object as Stripe.Subscription);
        break;
      case "charge.refunded":
        handled = await handleChargeRefunded(event.data.object as Stripe.Charge, event);
        break;
      case "charge.dispute.created":
      case "charge.dispute.closed":
        handled = await handleChargeDispute(event.data.object as Stripe.Dispute, event);
        break;
      default:
        handled = false;
    }
    await completeStripeWebhookEvent(event.id, handled ? "processed" : "ignored", null);
    return { eventId: event.id, type: event.type, handled };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await completeStripeWebhookEvent(event.id, "failed", message).catch(() => undefined);
    throw error;
  }
}

export function stripeRefundRequiresAccessRevocation(
  amount: number | null | undefined,
  amountRefunded: number | null | undefined,
): boolean {
  return Boolean(amount && amount > 0 && amountRefunded != null && amountRefunded >= amount);
}

export function stripeDisputeStatusToPlanStatus(
  status: Stripe.Dispute.Status | string,
  currentPeriodEnd: string | null,
  now = new Date(),
): StripeReconciledPlanStatus {
  if (status === "won") {
    return currentPeriodEnd && Date.parse(currentPeriodEnd) > now.getTime() ? "active" : "expired";
  }
  if (status === "lost") return "cancelled";
  return "paused";
}

export function stripeDisputeStatusToPaymentState(
  status: Stripe.Dispute.Status | string,
): Exclude<StripePaymentLifecycleState, "refunded"> {
  if (status === "won") return "cleared";
  if (status === "lost") return "dispute_lost";
  return "disputed";
}

export function stripeSubscriptionStatusToPlanStatus(
  status: Stripe.Subscription.Status | string,
): PlanStatus {
  switch (status) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
    case "incomplete":
    case "unpaid":
      return "past_due";
    case "paused":
      return "paused";
    case "canceled":
      return "cancelled";
    case "incomplete_expired":
      return "expired";
    default:
      return "expired";
  }
}

export function stripeCurrentPeriodEndIso(
  subscription: Pick<Stripe.Subscription, "ended_at" | "items" | "trial_end">,
): string | null {
  const periodEnd =
    subscription.items.data[0]?.current_period_end ??
    subscription.trial_end ??
    subscription.ended_at ??
    null;
  return periodEnd ? new Date(periodEnd * 1000).toISOString() : null;
}

async function ensureStripeCustomer(auth: SupabaseAuthContext): Promise<string> {
  const subscription = await getUserSubscription(auth);
  if (subscription?.stripe_customer_id) return subscription.stripe_customer_id;

  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email: typeof auth.claims.email === "string" ? auth.claims.email : undefined,
    metadata: {
      user_id: auth.userId,
      source: "immojudis",
    },
  });

  const existingMetadata = jsonObject(subscription?.metadata);
  const { error } = await supabaseAdmin.from("user_subscriptions").upsert(
    {
      user_id: auth.userId,
      plan_code: subscription?.plan_code ?? "decouverte",
      status: subscription?.status ?? "active",
      stripe_customer_id: customer.id,
      metadata: asJson({
        ...existingMetadata,
        stripe_customer_id: customer.id,
        stripe_customer_created_at: new Date().toISOString(),
      }),
    },
    { onConflict: "user_id" },
  );

  if (error) throw error;
  return customer.id;
}

async function getUserSubscription(auth: SupabaseAuthContext): Promise<UserSubscriptionRow | null> {
  const { data, error } = await auth.supabase
    .from("user_subscriptions")
    .select("*")
    .eq("user_id", auth.userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
  event: Stripe.Event,
): Promise<boolean> {
  const userId = session.metadata?.user_id || session.client_reference_id;
  if (!userId) return false;

  if (session.mode === "payment") {
    if (session.payment_status !== "paid") return false;
    if (normalizePlanCode(session.metadata?.plan_code) !== "analyse") return false;
    if (session.amount_total !== ANALYSIS_PRICE_CENTS || session.currency !== "eur") return false;
    if (session.metadata?.access_duration_days !== String(ANALYSIS_ACCESS_DAYS)) return false;
    const paymentIntentId = stripeObjectId(session.payment_intent);
    if (!paymentIntentId) return false;

    const client = supabaseAdmin as unknown as StripePaymentLifecycleRpcClient;
    const { data, error } = await client.rpc("grant_analysis_access_from_payment", {
      p_amount_total: session.amount_total,
      p_checkout_session_id: session.id,
      p_currency: session.currency,
      p_duration_days: ANALYSIS_ACCESS_DAYS,
      p_event_created: event.created,
      p_event_id: event.id,
      p_paid_at: new Date(event.created * 1000).toISOString(),
      p_payment_intent_id: paymentIntentId,
      p_stripe_customer_id: stripeObjectId(session.customer),
      p_user_id: userId,
    });

    if (error) throw error;
    const granted = Boolean(data?.[0]?.granted);
    const acceptanceId = session.metadata?.commercial_acceptance_id;
    if (granted && acceptanceId) {
      await sendCommercialConfirmation({
        acceptanceId,
        checkoutSessionId: session.id,
        userId,
        paidAt: new Date(event.created * 1000).toISOString(),
      }).catch((confirmationError) => {
        console.error("[billing] durable confirmation failed", confirmationError);
      });
    }
    return granted;
  }

  if (session.mode !== "subscription") return false;

  const subscriptionValue = session.subscription;
  const subscription =
    typeof subscriptionValue === "string"
      ? await getStripe().subscriptions.retrieve(subscriptionValue)
      : subscriptionValue;

  if (subscription?.object === "subscription") {
    return syncStripeSubscription(subscription, userId);
  }

  const customerId = stripeObjectId(session.customer);
  const { error } = await supabaseAdmin.from("user_subscriptions").upsert(
    {
      user_id: userId,
      plan_code: resolveStripePlanCode({
        metadataPlanCode: session.metadata?.plan_code,
        priceId: null,
      }),
      status: "active",
      stripe_customer_id: customerId,
      stripe_subscription_id: stripeObjectId(session.subscription),
      metadata: asJson({
        checkout_session_id: session.id,
        checkout_completed_at: new Date().toISOString(),
      }),
    },
    { onConflict: "user_id" },
  );

  if (error) throw error;
  return true;
}

async function beginStripeWebhookEvent(event: Stripe.Event): Promise<boolean> {
  const client = supabaseAdmin as unknown as StripeWebhookEventRpcClient;
  const { data, error } = await client.rpc("begin_stripe_webhook_event", {
    p_event_id: event.id,
    p_event_type: event.type,
    p_livemode: event.livemode,
  });
  if (error) throw new Error(error.message || "Journal Stripe indisponible.");
  return data === true;
}

async function completeStripeWebhookEvent(
  eventId: string,
  status: "processed" | "ignored" | "failed",
  errorMessage: string | null,
): Promise<void> {
  const client = supabaseAdmin as unknown as StripeWebhookEventRpcClient;
  const { error } = await client.rpc("complete_stripe_webhook_event", {
    p_error_message: errorMessage,
    p_event_id: eventId,
    p_processing_status: status,
  });
  if (error) throw new Error(error.message || "Mise à jour du journal Stripe impossible.");
}

async function handleChargeRefunded(charge: Stripe.Charge, event: Stripe.Event): Promise<boolean> {
  if (!stripeRefundRequiresAccessRevocation(charge.amount, charge.amount_refunded)) return false;
  const userId = await stripeUserIdFromPaymentObject(charge);
  const paymentIntentId = stripeObjectId(charge.payment_intent);
  if (!userId || !paymentIntentId) return false;
  return recordStripePaymentState({
    userId,
    paymentIntentId,
    state: "refunded",
    status: "cancelled",
    event,
    revokeImmediately: true,
  });
}

async function handleChargeDispute(dispute: Stripe.Dispute, event: Stripe.Event): Promise<boolean> {
  const charge =
    typeof dispute.charge === "string"
      ? await getStripe().charges.retrieve(dispute.charge)
      : dispute.charge;
  const userId = await stripeUserIdFromPaymentObject(charge);
  const paymentIntentId = stripeObjectId(charge.payment_intent);
  if (!userId || !paymentIntentId) return false;

  const { data, error } = await supabaseAdmin
    .from("user_subscriptions")
    .select("current_period_end")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  const status = stripeDisputeStatusToPlanStatus(dispute.status, data?.current_period_end ?? null);
  return recordStripePaymentState({
    userId,
    paymentIntentId,
    state: stripeDisputeStatusToPaymentState(dispute.status),
    status,
    event,
    revokeImmediately: status === "cancelled",
  });
}

async function stripeUserIdFromPaymentObject(charge: Stripe.Charge): Promise<string | null> {
  if (charge.metadata?.user_id) return charge.metadata.user_id;
  const paymentIntentValue = charge.payment_intent;
  if (!paymentIntentValue) return null;
  const paymentIntent =
    typeof paymentIntentValue === "string"
      ? await getStripe().paymentIntents.retrieve(paymentIntentValue)
      : paymentIntentValue;
  return paymentIntent.metadata?.user_id ?? null;
}

async function recordStripePaymentState({
  userId,
  paymentIntentId,
  state,
  status,
  event,
  revokeImmediately,
}: {
  userId: string;
  paymentIntentId: string;
  state: StripePaymentLifecycleState;
  status: StripeReconciledPlanStatus;
  event: Stripe.Event;
  revokeImmediately: boolean;
}): Promise<boolean> {
  const client = supabaseAdmin as unknown as StripePaymentLifecycleRpcClient;
  const { data, error } = await client.rpc("record_stripe_payment_state", {
    p_entitlement_status: status,
    p_event_created: event.created,
    p_event_id: event.id,
    p_event_type: event.type,
    p_payment_intent_id: paymentIntentId,
    p_revoke_immediately: revokeImmediately,
    p_state: state,
    p_user_id: userId,
  });
  if (error) throw new Error(error.message || "Réconciliation du paiement Stripe impossible.");
  return data?.[0]?.recorded === true;
}

async function syncStripeSubscription(
  subscription: Stripe.Subscription,
  fallbackUserId?: string | null,
): Promise<boolean> {
  const userId = fallbackUserId || (await findUserIdForSubscription(subscription));
  if (!userId) return false;

  const customerId = stripeObjectId(subscription.customer);
  const price = subscription.items.data[0]?.price;
  const status = stripeSubscriptionStatusToPlanStatus(subscription.status);
  const plan = resolveStripePlanCode({
    metadataPlanCode: subscription.metadata?.plan_code,
    priceId: price?.id ?? null,
  });

  const { error } = await supabaseAdmin.from("user_subscriptions").upsert(
    {
      user_id: userId,
      plan_code: plan,
      status,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscription.id,
      current_period_end: stripeCurrentPeriodEndIso(subscription),
      metadata: asJson({
        stripe_status: subscription.status,
        stripe_price_id: price?.id ?? null,
        stripe_product_id: stripeObjectId(price?.product),
        cancel_at_period_end: subscription.cancel_at_period_end,
        canceled_at: unixToIso(subscription.canceled_at),
        synced_at: new Date().toISOString(),
      }),
    },
    { onConflict: "user_id" },
  );

  if (error) throw error;
  return true;
}

export function resolveCheckoutPlanCode(_value: unknown): Exclude<PlanCode, "decouverte"> {
  return "analyse";
}

export function resolveStripePlanCode({
  metadataPlanCode,
  priceId,
}: {
  metadataPlanCode?: string | null;
  priceId?: string | null;
}): Exclude<PlanCode, "decouverte"> {
  void metadataPlanCode;
  void priceId;
  return "analyse";
}

async function findUserIdForSubscription(
  subscription: Stripe.Subscription,
): Promise<string | null> {
  const userId = subscription.metadata?.user_id;
  if (userId) return userId;

  const bySubscription = await supabaseAdmin
    .from("user_subscriptions")
    .select("user_id")
    .eq("stripe_subscription_id", subscription.id)
    .maybeSingle();
  if (bySubscription.error) throw bySubscription.error;
  if (bySubscription.data?.user_id) return bySubscription.data.user_id;

  const customerId = stripeObjectId(subscription.customer);
  if (!customerId) return null;

  const byCustomer = await supabaseAdmin
    .from("user_subscriptions")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  if (byCustomer.error) throw byCustomer.error;
  return byCustomer.data?.user_id ?? null;
}

function stripeObjectId(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "id" in value && typeof value.id === "string") {
    return value.id;
  }
  return null;
}

function unixToIso(value: number | null | undefined): string | null {
  return value ? new Date(value * 1000).toISOString() : null;
}

function jsonObject(value: Json | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}
