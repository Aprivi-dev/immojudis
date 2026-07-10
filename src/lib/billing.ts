import Stripe from "stripe";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { normalizePlanCode, type PlanCode, type PlanStatus } from "@/lib/plans";

type UserSubscriptionRow = Database["public"]["Tables"]["user_subscriptions"]["Row"];

export type BillingSessionResponse = {
  url: string;
};

export type StripeWebhookResult = {
  eventId: string;
  type: string;
  handled: boolean;
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
  const configuredOrigin =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.VERCEL_URL;
  const rawOrigin = configuredOrigin || requestOrigin || "http://localhost:3000";
  const origin = /^https?:\/\//i.test(rawOrigin) ? rawOrigin : `https://${rawOrigin}`;
  return origin.replace(/\/+$/, "");
}

export async function createAnalyseCheckoutSession({
  auth,
  origin,
}: {
  auth: SupabaseAuthContext;
  origin?: string | null;
}): Promise<BillingSessionResponse> {
  return createPlanCheckoutSession({ auth, origin, plan: "analyse" });
}

export async function createPlanCheckoutSession({
  auth,
  origin,
  plan,
}: {
  auth: SupabaseAuthContext;
  origin?: string | null;
  plan: Exclude<PlanCode, "decouverte">;
}): Promise<BillingSessionResponse> {
  const stripe = getStripe();
  const appOrigin = resolveBillingOrigin(origin);
  const customerId = await ensureStripeCustomer(auth);

  const session = await stripe.checkout.sessions.create(
    buildAnalysisCheckoutSessionParams({
      appOrigin,
      customerId,
      userId: auth.userId,
    }),
  );

  if (!session.url) throw new Error("Session de paiement Stripe indisponible.");
  return { url: session.url };
}

export function buildAnalysisCheckoutSessionParams({
  appOrigin,
  customerId,
  userId,
}: {
  appOrigin: string;
  customerId: string;
  userId: string;
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
    success_url: `${appOrigin}/accompagnement?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appOrigin}/accompagnement?checkout=cancelled`,
    metadata: {
      user_id: userId,
      plan_code: "analyse",
      access_duration_days: String(ANALYSIS_ACCESS_DAYS),
      billing_model: "one_time_30_days",
    },
    payment_intent_data: {
      metadata: {
        user_id: userId,
        plan_code: "analyse",
        access_duration_days: String(ANALYSIS_ACCESS_DAYS),
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

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return {
        eventId: event.id,
        type: event.type,
        handled: await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session),
      };
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      return {
        eventId: event.id,
        type: event.type,
        handled: await syncStripeSubscription(event.data.object as Stripe.Subscription),
      };
    default:
      return { eventId: event.id, type: event.type, handled: false };
  }
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

async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<boolean> {
  const userId = session.metadata?.user_id || session.client_reference_id;
  if (!userId) return false;

  if (session.mode === "payment") {
    if (session.payment_status !== "paid") return false;
    if (normalizePlanCode(session.metadata?.plan_code) !== "analyse") return false;
    if (session.amount_total !== ANALYSIS_PRICE_CENTS || session.currency !== "eur") return false;
    if (session.metadata?.access_duration_days !== String(ANALYSIS_ACCESS_DAYS)) return false;

    const { data, error } = await supabaseAdmin.rpc("grant_analysis_access_from_checkout", {
      p_amount_total: session.amount_total,
      p_checkout_session_id: session.id,
      p_currency: session.currency,
      p_duration_days: ANALYSIS_ACCESS_DAYS,
      p_paid_at: new Date().toISOString(),
      p_stripe_customer_id: stripeObjectId(session.customer),
      p_user_id: userId,
    });

    if (error) throw error;
    return Boolean(data?.[0]?.granted);
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
