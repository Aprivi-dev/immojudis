import Stripe from "stripe";
import { createHash, randomUUID } from "node:crypto";
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
import { sendPaymentFailedNotice, sendTrialEndingNotice } from "@/lib/billing-notices";
import {
  ANALYSIS_BILLING_MODEL,
  ANALYSIS_CHECKOUT_EXPIRY_MINUTES,
  ANALYSIS_OFFER_CODE,
  ANALYSIS_RECURRING_CURRENCY,
  ANALYSIS_RECURRING_INTERVAL,
  ANALYSIS_RECURRING_INTERVAL_COUNT,
  ANALYSIS_RECURRING_PRICE_CENTS,
  ANALYSIS_SUBSCRIPTION_BILLING_MODEL,
  ANALYSIS_SUBSCRIPTION_OFFER_CODE,
  ANALYSIS_TRIAL_DAYS,
  resolveAnalysisOfferLabel,
} from "@/lib/analysis-offer";

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

type TrialCardRpcClient = {
  rpc(
    name: "claim_trial_card",
    args: { p_fingerprint_hash: string; p_user_id: string },
  ): Promise<{ data: boolean | null; error: { message?: string } | null }>;
};

type StripeSubscriptionRpcClient = {
  rpc(
    name: "apply_stripe_subscription_state",
    args: {
      p_current_period_end: string | null;
      p_event_created: number;
      p_metadata: Json;
      p_plan_code: PlanCode;
      p_status: PlanStatus;
      p_stripe_customer_id: string | null;
      p_stripe_subscription_id: string;
      p_user_id: string;
    },
  ): Promise<{
    data: Array<{ applied: boolean; reason: string }> | null;
    error: { message?: string } | null;
  }>;
};

type StripeCheckoutReservationRpcClient = {
  rpc(
    name: "reserve_analyse_checkout",
    args: { p_checkout_token: string; p_user_id: string },
  ): Promise<{ data: boolean | null; error: { message?: string } | null }>;
  rpc(
    name: "release_analyse_checkout",
    args: { p_checkout_token: string; p_user_id: string },
  ): Promise<{ data: boolean | null; error: { message?: string } | null }>;
  rpc(
    name: "attach_analyse_checkout_customer",
    args: {
      p_checkout_token: string;
      p_stripe_customer_id: string;
      p_user_id: string;
    },
  ): Promise<{ data: string | null; error: { message?: string } | null }>;
};

const STRIPE_API_VERSION = "2026-06-24.dahlia";
export {
  ANALYSIS_CHECKOUT_EXPIRY_MINUTES,
  ANALYSIS_OFFER_CODE,
  ANALYSIS_RECURRING_CURRENCY,
  ANALYSIS_RECURRING_INTERVAL,
  ANALYSIS_RECURRING_INTERVAL_COUNT,
  ANALYSIS_RECURRING_PRICE_CENTS,
  ANALYSIS_SUBSCRIPTION_BILLING_MODEL,
  ANALYSIS_SUBSCRIPTION_OFFER_CODE,
  ANALYSIS_TRIAL_DAYS,
} from "@/lib/analysis-offer";
export const ANALYSIS_ACCESS_DAYS = 30;
/** Legacy one-time constants retained for validating historical webhooks. */
export const ANALYSIS_PRICE_CENTS = ANALYSIS_RECURRING_PRICE_CENTS;

export function resolveAnalysisPriceId(env: Pick<NodeJS.ProcessEnv, string> = process.env): string {
  const priceId = env.STRIPE_ANALYSIS_PRICE_ID?.trim();
  if (!priceId) {
    throw new Error(
      "Stripe Analyse n'est pas configuré: STRIPE_ANALYSIS_PRICE_ID manquant pour le tarif validé de 29 € / mois.",
    );
  }
  if (!/^price_[A-Za-z0-9]+$/.test(priceId)) {
    throw new Error("Stripe Analyse n'est pas configuré: STRIPE_ANALYSIS_PRICE_ID invalide.");
  }
  return priceId;
}

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
  plan: _plan,
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
  const priceId = resolveAnalysisPriceId();
  const price = await resolveConfiguredAnalysisPrice(stripe, priceId);
  const reservationToken = randomUUID();
  // Start the Session window before acquiring the database reservation so
  // Customer/history requests cannot make Checkout outlive that reservation.
  const checkoutExpiresAt = Math.floor(Date.now() / 1000) + ANALYSIS_CHECKOUT_EXPIRY_MINUTES * 60;
  if (!(await reserveAnalyseCheckout(auth.userId, reservationToken))) {
    throw new Error(
      "Un abonnement Analyse ou un checkout est déjà associé à ce compte. Gérez-le depuis le portail Stripe.",
    );
  }
  const acceptanceId = randomUUID();

  let session: Stripe.Checkout.Session | null = null;
  try {
    // The account reservation must already exist before Customer creation. The
    // RPC-backed attach below then merges the customer id while retaining this
    // reservation token, so a second first checkout cannot race this request.
    const customerId = await ensureStripeCustomer(auth, reservationToken);
    const subscriptionHistory = await listCustomerSubscriptions(stripe, customerId);
    if (
      subscriptionHistory.some((subscription) =>
        ["trialing", "active", "past_due", "paused", "incomplete"].includes(subscription.status),
      )
    ) {
      throw new Error(
        "Un abonnement Analyse ou un checkout est déjà associé à ce compte. Gérez-le depuis le portail Stripe.",
      );
    }
    const trialAvailable = !subscriptionHistory.some(
      (subscription) => subscription.trial_start != null || subscription.trial_end != null,
    );
    const trialDays = trialAvailable ? ANALYSIS_TRIAL_DAYS : 0;
    const offerCode = trialAvailable ? ANALYSIS_OFFER_CODE : ANALYSIS_SUBSCRIPTION_OFFER_CODE;
    const billingModel = trialAvailable
      ? ANALYSIS_BILLING_MODEL
      : ANALYSIS_SUBSCRIPTION_BILLING_MODEL;

    session = await stripe.checkout.sessions.create(
      buildAnalysisCheckoutSessionParams({
        appOrigin,
        customerId,
        userId: auth.userId,
        acceptanceId,
        priceId,
        reservationToken,
        trialDays,
        offerCode,
        billingModel,
        expiresAt: checkoutExpiresAt,
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
      offer: {
        priceId,
        offerCode,
        billingModel,
        trialDays,
        amountCents: price.unit_amount,
        currency: price.currency,
        recurringInterval: price.recurring?.interval ?? null,
        recurringIntervalCount: price.recurring?.interval_count ?? null,
      },
    });
    return { url: session.url };
  } catch (error) {
    let canReleaseReservation = canReleaseCheckoutReservationAfterFailure(session?.status, false);
    if (session?.status === "open") {
      try {
        await stripe.checkout.sessions.expire(session.id);
        canReleaseReservation = true;
      } catch {
        // Keep the reservation until Stripe emits `checkout.session.expired`.
      }
    }
    if (canReleaseReservation) {
      await releaseAnalyseCheckout(auth.userId, reservationToken).catch(() => undefined);
    }
    throw error;
  }
}

export function canReleaseCheckoutReservationAfterFailure(
  status: Stripe.Checkout.Session.Status | null | undefined,
  expirationSucceeded: boolean,
): boolean {
  if (status == null || status === "expired") return true;
  return status === "open" && expirationSucceeded;
}

export async function resolveAnalysisCheckoutAvailability(
  auth: SupabaseAuthContext,
): Promise<{ trialAvailable: boolean }> {
  const subscription = await getUserSubscription(auth);
  if (!subscription?.stripe_customer_id) return { trialAvailable: true };
  const history = await listCustomerSubscriptions(getStripe(), subscription.stripe_customer_id);
  return {
    trialAvailable: !history.some((item) => item.trial_start != null || item.trial_end != null),
  };
}

async function listCustomerSubscriptions(
  stripe: Stripe,
  customerId: string,
): Promise<Stripe.Subscription[]> {
  const data: Stripe.Subscription[] = [];
  let startingAfter: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const page = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    data.push(...page.data);
    hasMore = page.has_more;
    startingAfter = page.data.at(-1)?.id;
    if (!startingAfter) hasMore = false;
  }

  return data;
}

export function buildAnalysisCheckoutSessionParams({
  appOrigin,
  customerId,
  userId,
  acceptanceId,
  priceId,
  reservationToken,
  trialDays = ANALYSIS_TRIAL_DAYS,
  offerCode = ANALYSIS_OFFER_CODE,
  billingModel = ANALYSIS_BILLING_MODEL,
  expiresAt,
}: {
  appOrigin: string;
  customerId: string;
  userId: string;
  acceptanceId?: string;
  priceId?: string;
  reservationToken?: string;
  trialDays?: number;
  offerCode?: string;
  billingModel?: string;
  expiresAt?: number;
}): Stripe.Checkout.SessionCreateParams {
  const recurringPriceId = priceId ?? resolveAnalysisPriceId();
  const offerLabel = resolveAnalysisOfferLabel();
  return {
    mode: "subscription",
    customer: customerId,
    client_reference_id: userId,
    line_items: [
      {
        price: recurringPriceId,
        quantity: 1,
      },
    ],
    payment_method_collection: "always",
    // Professionals need an invoice in their company's name: collect the
    // billing address and an optional VAT number, and keep them on the customer.
    billing_address_collection: "required",
    tax_id_collection: { enabled: true },
    customer_update: { name: "auto", address: "auto" },
    subscription_data: {
      ...(trialDays > 0 ? { trial_period_days: trialDays } : {}),
      metadata: {
        user_id: userId,
        plan_code: "analyse",
        billing_model: billingModel,
        trial_days: String(trialDays),
        offer_code: offerCode,
        offer_label: offerLabel,
        ...(reservationToken ? { checkout_reservation_token: reservationToken } : {}),
        ...(acceptanceId ? { commercial_acceptance_id: acceptanceId } : {}),
      },
    },
    locale: "fr",
    success_url: `${appOrigin}/offres?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appOrigin}/offres?checkout=cancelled`,
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    metadata: {
      user_id: userId,
      plan_code: "analyse",
      billing_model: billingModel,
      trial_days: String(trialDays),
      offer_code: offerCode,
      offer_label: offerLabel,
      ...(reservationToken ? { checkout_reservation_token: reservationToken } : {}),
      ...(acceptanceId ? { commercial_acceptance_id: acceptanceId } : {}),
    },
  };
}

async function resolveConfiguredAnalysisPrice(
  stripe: Stripe,
  priceId: string,
): Promise<Stripe.Price> {
  const price = await stripe.prices.retrieve(priceId);
  if (
    !price.active ||
    price.type !== "recurring" ||
    price.currency !== ANALYSIS_RECURRING_CURRENCY ||
    !price.recurring ||
    price.unit_amount !== ANALYSIS_RECURRING_PRICE_CENTS ||
    price.recurring.interval !== ANALYSIS_RECURRING_INTERVAL ||
    price.recurring.interval_count !== ANALYSIS_RECURRING_INTERVAL_COUNT
  ) {
    throw new Error("Le Price Stripe Analyse doit être actif et récurrent à 29 € / mois en EUR.");
  }
  return price;
}

async function reserveAnalyseCheckout(userId: string, checkoutToken: string): Promise<boolean> {
  const client = supabaseAdmin as unknown as StripeCheckoutReservationRpcClient;
  const { data, error } = await client.rpc("reserve_analyse_checkout", {
    p_checkout_token: checkoutToken,
    p_user_id: userId,
  });
  if (error) throw new Error(error.message || "Réservation du checkout Analyse impossible.");
  return data === true;
}

async function releaseAnalyseCheckout(userId: string, checkoutToken: string): Promise<void> {
  const client = supabaseAdmin as unknown as StripeCheckoutReservationRpcClient;
  const { error } = await client.rpc("release_analyse_checkout", {
    p_checkout_token: checkoutToken,
    p_user_id: userId,
  });
  if (error) throw new Error(error.message || "Libération du checkout Analyse impossible.");
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
      case "checkout.session.expired":
        handled = await handleCheckoutExpired(event.data.object as Stripe.Checkout.Session);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        handled = await syncStripeSubscription(
          event.data.object as Stripe.Subscription,
          null,
          event.created,
        );
        break;
      case "customer.subscription.trial_will_end":
        handled = await handleTrialWillEnd(event.data.object as Stripe.Subscription);
        break;
      case "invoice.payment_failed":
        handled = await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
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

export function stripeCustomerIdempotencyKey(userId: string): string {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) throw new Error("Identifiant utilisateur Stripe manquant.");
  return `immojudis-customer-${normalizedUserId}`;
}

async function ensureStripeCustomer(
  auth: SupabaseAuthContext,
  reservationToken: string,
): Promise<string> {
  const subscription = await getUserSubscription(auth);
  if (subscription?.stripe_customer_id) return subscription.stripe_customer_id;

  const stripe = getStripe();
  const customer = await stripe.customers.create(
    {
      email: typeof auth.claims.email === "string" ? auth.claims.email : undefined,
      metadata: {
        user_id: auth.userId,
        source: "immojudis",
      },
    },
    {
      idempotencyKey: stripeCustomerIdempotencyKey(auth.userId),
    },
  );

  const client = supabaseAdmin as unknown as StripeCheckoutReservationRpcClient;
  const { data, error } = await client.rpc("attach_analyse_checkout_customer", {
    p_checkout_token: reservationToken,
    p_stripe_customer_id: customer.id,
    p_user_id: auth.userId,
  });
  if (error) {
    throw new Error(error.message || "Association du compte Stripe impossible.");
  }
  if (!data) throw new Error("Association du compte Stripe impossible.");
  return data;
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
    const synced = await syncStripeSubscription(subscription, userId, event.created);
    if (synced) await releaseCheckoutReservation(session);
    const acceptanceId = session.metadata?.commercial_acceptance_id;
    if (synced && acceptanceId) {
      await sendCommercialConfirmation({
        acceptanceId,
        checkoutSessionId: session.id,
        userId,
        paidAt: new Date(event.created * 1000).toISOString(),
      }).catch((confirmationError) => {
        console.error("[billing] durable confirmation failed", confirmationError);
      });
    }
    return synced;
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
  await releaseCheckoutReservation(session);
  const acceptanceId = session.metadata?.commercial_acceptance_id;
  if (acceptanceId) {
    await sendCommercialConfirmation({
      acceptanceId,
      checkoutSessionId: session.id,
      userId,
      paidAt: new Date(event.created * 1000).toISOString(),
    }).catch((confirmationError) => {
      console.error("[billing] durable confirmation failed", confirmationError);
    });
  }
  return true;
}

async function handleCheckoutExpired(session: Stripe.Checkout.Session): Promise<boolean> {
  const userId = session.metadata?.user_id || session.client_reference_id;
  const reservationToken = session.metadata?.checkout_reservation_token;
  if (!userId || !reservationToken) return false;
  await releaseAnalyseCheckout(userId, reservationToken);
  return true;
}

async function releaseCheckoutReservation(session: Stripe.Checkout.Session): Promise<void> {
  const userId = session.metadata?.user_id || session.client_reference_id;
  const reservationToken = session.metadata?.checkout_reservation_token;
  if (!userId || !reservationToken) return;
  await releaseAnalyseCheckout(userId, reservationToken).catch((error) => {
    console.error("[billing] checkout reservation release failed", error);
  });
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
  const recorded = await recordStripePaymentState({
    userId,
    paymentIntentId,
    state: "refunded",
    status: "cancelled",
    event,
    revokeImmediately: true,
  });
  // A refunded customer must not be charged again at the next renewal, and the
  // subscription events that follow must report a cancelled state.
  if (recorded) await cancelStripeSubscriptionForUser(userId);
  return recorded;
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
  const recorded = await recordStripePaymentState({
    userId,
    paymentIntentId,
    state: stripeDisputeStatusToPaymentState(dispute.status),
    status,
    event,
    revokeImmediately: status === "cancelled",
  });
  if (recorded && status === "cancelled") await cancelStripeSubscriptionForUser(userId);
  return recorded;
}

/** Stripe sends this three days before a trial ends. */
async function handleTrialWillEnd(subscription: Stripe.Subscription): Promise<boolean> {
  const userId = await findUserIdForSubscription(subscription);
  if (!userId || !subscription.trial_end) return false;
  await sendTrialEndingNotice({
    userId,
    subscriptionId: subscription.id,
    trialEnd: subscription.trial_end,
  });
  return true;
}

/**
 * One free trial per payment card.  When the card behind a trial already
 * started a trial for another account, the trial ends now and the first
 * payment is taken immediately.
 */
export async function enforceSingleTrialPerCard(
  subscription: Stripe.Subscription,
  userId: string,
): Promise<"claimed" | "reused" | "unknown"> {
  if (subscription.status !== "trialing") return "unknown";
  const stripe = getStripe();
  let paymentMethodId = stripeObjectId(subscription.default_payment_method);
  if (!paymentMethodId) {
    const customerId = stripeObjectId(subscription.customer);
    if (customerId) {
      const customer = await stripe.customers.retrieve(customerId);
      if (!("deleted" in customer && customer.deleted)) {
        paymentMethodId = stripeObjectId(
          (customer as Stripe.Customer).invoice_settings?.default_payment_method,
        );
      }
    }
  }
  if (!paymentMethodId) return "unknown";
  const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
  const fingerprint = paymentMethod.card?.fingerprint;
  if (!fingerprint) return "unknown";

  const client = supabaseAdmin as unknown as TrialCardRpcClient;
  const { data, error } = await client.rpc("claim_trial_card", {
    p_fingerprint_hash: createHash("sha256").update(fingerprint).digest("hex"),
    p_user_id: userId,
  });
  if (error) throw new Error(error.message || "Contrôle de l'essai par carte impossible.");
  if (data === true) return "claimed";

  await stripe.subscriptions.update(subscription.id, { trial_end: "now" });
  console.warn("[billing] trial ended early: card already used for another trial", {
    subscription: subscription.id,
  });
  return "reused";
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<boolean> {
  const customerId = stripeObjectId(invoice.customer);
  if (!customerId || !invoice.id) return false;
  const { data, error } = await supabaseAdmin
    .from("user_subscriptions")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.user_id) return false;
  await sendPaymentFailedNotice({
    userId: data.user_id,
    invoiceId: invoice.id,
    nextAttemptAt: invoice.next_payment_attempt,
  });
  return true;
}

function isStripeMissingOrCancelled(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === "resource_missing" ||
    (typeof message === "string" &&
      /already.*cancel|cancel.*subscription|no such subscription/i.test(message))
  );
}

async function cancelStripeSubscriptionForUser(userId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("user_subscriptions")
    .select("stripe_subscription_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  const subscriptionId = data?.stripe_subscription_id;
  if (!subscriptionId) return;
  try {
    await getStripe().subscriptions.cancel(subscriptionId);
  } catch (cancelError) {
    if (!isStripeMissingOrCancelled(cancelError)) throw cancelError;
  }
}

async function stripeUserIdFromPaymentObject(charge: Stripe.Charge): Promise<string | null> {
  if (charge.metadata?.user_id) return charge.metadata.user_id;
  const paymentIntentValue = charge.payment_intent;
  if (paymentIntentValue) {
    const paymentIntent =
      typeof paymentIntentValue === "string"
        ? await getStripe().paymentIntents.retrieve(paymentIntentValue)
        : paymentIntentValue;
    if (paymentIntent.metadata?.user_id) return paymentIntent.metadata.user_id;
  }
  // Subscription invoices carry no ImmoJudis metadata: the Stripe customer is
  // the reliable link to the account.
  const customerId = stripeObjectId(charge.customer);
  if (!customerId) return null;
  const { data, error } = await supabaseAdmin
    .from("user_subscriptions")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  if (error) throw error;
  return data?.user_id ?? null;
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

async function retrieveCurrentSubscription(
  subscription: Stripe.Subscription,
): Promise<Stripe.Subscription> {
  try {
    return await getStripe().subscriptions.retrieve(subscription.id);
  } catch (error) {
    if (isStripeMissingOrCancelled(error)) return subscription;
    throw error;
  }
}

/** True when the price is the approved Analyse price (or none is configured yet). */
export function isAnalysisSubscriptionPrice(
  priceId: string | null | undefined,
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): boolean {
  const configured = env.STRIPE_ANALYSIS_PRICE_ID?.trim();
  return !configured || !priceId || priceId === configured;
}

/**
 * Store the state Stripe holds now, not the one in the (possibly late or
 * replayed) payload. The database applies it only if it is not older than the
 * newest applied event and not a reactivation of a refunded subscription.
 */
async function syncStripeSubscription(
  subscription: Stripe.Subscription,
  fallbackUserId: string | null | undefined,
  eventCreated: number,
): Promise<boolean> {
  const userId = fallbackUserId || (await findUserIdForSubscription(subscription));
  if (!userId) return false;

  const current = await retrieveCurrentSubscription(subscription);
  const customerId = stripeObjectId(current.customer);
  const price = current.items.data[0]?.price;
  const status = stripeSubscriptionStatusToPlanStatus(current.status);
  const plan: PlanCode = isAnalysisSubscriptionPrice(price?.id)
    ? resolveStripePlanCode({
        metadataPlanCode: current.metadata?.plan_code,
        priceId: price?.id ?? null,
      })
    : "decouverte";
  if (plan === "decouverte") {
    console.warn("[billing] subscription with an unrecognised price ignored", {
      subscription: current.id,
      price: price?.id ?? null,
    });
  }

  const client = supabaseAdmin as unknown as StripeSubscriptionRpcClient;
  const { data, error } = await client.rpc("apply_stripe_subscription_state", {
    p_current_period_end: stripeCurrentPeriodEndIso(current),
    p_event_created: eventCreated,
    p_metadata: asJson({
      stripe_status: current.status,
      stripe_price_id: price?.id ?? null,
      stripe_product_id: stripeObjectId(price?.product),
      stripe_price_amount_cents: price?.unit_amount ?? null,
      stripe_price_currency: price?.currency ?? null,
      stripe_price_interval: price?.recurring?.interval ?? null,
      stripe_price_interval_count: price?.recurring?.interval_count ?? null,
      stripe_subscription_created_at: unixToIso(current.created),
      stripe_trial_start: unixToIso(current.trial_start),
      stripe_trial_end: unixToIso(current.trial_end),
      stripe_first_invoice_at: unixToIso(current.trial_end ?? current.created),
      stripe_current_period_end: stripeCurrentPeriodEndIso(current),
      cancel_at_period_end: current.cancel_at_period_end,
      canceled_at: unixToIso(current.canceled_at),
      synced_at: new Date().toISOString(),
    }),
    p_plan_code: plan,
    p_status: status,
    p_stripe_customer_id: customerId,
    p_stripe_subscription_id: current.id,
    p_user_id: userId,
  });
  if (error) throw new Error(error.message || "Synchronisation de l'abonnement Stripe impossible.");
  const result = data?.[0];
  if (result?.applied && current.status === "trialing") {
    try {
      await enforceSingleTrialPerCard(current, userId);
    } catch (trialError) {
      // Never block access synchronisation on the anti-abuse check.
      console.error("[billing] single-trial check failed", trialError);
    }
  }
  if (result && !result.applied) {
    console.info("[billing] stale or reversed subscription event ignored", {
      subscription: current.id,
      reason: result.reason,
    });
  }
  return result?.applied === true;
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

function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}
