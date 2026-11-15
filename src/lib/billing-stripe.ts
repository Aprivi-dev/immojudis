import "server-only";
import Stripe from "stripe";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { VAT_EXEMPTION_INVOICE_MENTION } from "@/lib/analysis-offer";
import { ConfigurationError } from "@/lib/api-errors";
import { serverEnv } from "@/lib/env";
import { resolveSiteOrigin } from "@/lib/site-url";

/**
 * Socle Stripe partagé par l'abonnement (`billing.ts`), l'achat à l'unité (`billing-sale-unlock.ts`) et
 * la déduction du premier mois (`billing-unit-deduction.ts`) : client Stripe, client Stripe du compte,
 * lectures communes. Ne dépend d'aucun de ces modules, pour qu'ils ne dépendent pas les uns des autres.
 */

export type BillingSessionResponse = {
  url: string;
};

export type UserSubscriptionRow = Database["public"]["Tables"]["user_subscriptions"]["Row"];

const STRIPE_API_VERSION = "2026-06-24.dahlia";

let stripeClient: Stripe | undefined;

export function stripeSecretKey(): string {
  const key = serverEnv().stripe.secretKey;
  if (!key) throw new ConfigurationError("Stripe n'est pas configuré: STRIPE_SECRET_KEY manquant.");
  return key;
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

export function stripeCustomerIdempotencyKey(userId: string): string {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) throw new Error("Stripe customer: user id is missing.");
  return `immojudis-customer-${normalizedUserId}`;
}

/**
 * Crée le client Stripe du compte. Mêmes paramètres et même clé d'idempotence pour l'abonnement et
 * l'achat à l'unité : deux créations dans les 24 heures de la clé rendent le même client, et des
 * paramètres différents feraient refuser la seconde par Stripe.
 */
export function createStripeCustomer(
  stripe: Stripe,
  auth: SupabaseAuthContext,
): Promise<Stripe.Customer> {
  return stripe.customers.create(
    {
      email: typeof auth.claims.email === "string" ? auth.claims.email : undefined,
      // Franchise en base de TVA : mention obligatoire sur chaque facture émise par Stripe.
      invoice_settings: { footer: VAT_EXEMPTION_INVOICE_MENTION },
      metadata: {
        user_id: auth.userId,
        source: "immojudis",
      },
    },
    {
      idempotencyKey: stripeCustomerIdempotencyKey(auth.userId),
    },
  );
}

export async function getUserSubscription(
  auth: SupabaseAuthContext,
): Promise<UserSubscriptionRow | null> {
  const { data, error } = await auth.supabase
    .from("user_subscriptions")
    .select("*")
    .eq("user_id", auth.userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export function isStripeMissingOrCancelled(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === "resource_missing" ||
    (typeof message === "string" &&
      /already.*cancel|cancel.*subscription|no such subscription/i.test(message))
  );
}

export function stripeObjectId(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "id" in value && typeof value.id === "string") {
    return value.id;
  }
  return null;
}
