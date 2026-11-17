import "server-only";
import Stripe from "stripe";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { VAT_EXEMPTION_INVOICE_MENTION } from "@/lib/analysis-offer";
import { ConfigurationError } from "@/lib/api-errors";
import { serverEnv } from "@/lib/env";
import { resolveSiteOrigin } from "@/lib/site-url";
import { isUuid } from "@/lib/uuid";

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
 * Client Stripe du compte : le retrouve chez Stripe par sa métadonnée `user_id`, sinon le crée.
 * Seule règle des deux parcours (abonnement et achat à l'unité) : la base ne garde l'identifiant du
 * client que pour l'abonnement, et la clé d'idempotence de la création ne vaut que 24 heures chez
 * Stripe. Sans cette recherche, deux achats à plus de 24 heures d'intervalle créeraient deux clients.
 * Une erreur de la recherche remonte : créer quand même referait des doublons.
 */
export async function findOrCreateStripeCustomer(
  stripe: Stripe,
  auth: SupabaseAuthContext,
): Promise<Stripe.Customer> {
  const oldest = (await findStripeCustomersOfAccount(stripe, auth.userId)).reduce<
    Stripe.Customer | undefined
  >((kept, customer) => (!kept || customer.created < kept.created ? customer : kept), undefined);
  if (oldest) return oldest;

  // La recherche Stripe n'indexe un nouveau client qu'après un délai : deux créations rapprochées ne
  // se voient pas. La clé d'idempotence couvre ce délai (24 heures) en rendant le même client, à
  // condition de garder les mêmes paramètres pour les deux parcours (sinon Stripe refuse la seconde).
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

/**
 * Clients Stripe (non supprimés) rattachés au compte par leur métadonnée `user_id` : seule requête qui
 * les retrouve, pour la création (`findOrCreateStripeCustomer`) comme pour l'effacement du compte.
 */
export async function findStripeCustomersOfAccount(
  stripe: Stripe,
  userId: string,
): Promise<Stripe.Customer[]> {
  // Le jeton vérifié donne un UUID ; on le contrôle quand même avant de l'écrire dans la requête de
  // recherche, pour qu'aucune valeur ne puisse en changer la syntaxe.
  if (!isUuid(userId)) throw new Error("Stripe customer: user id is not a UUID.");
  const found = await stripe.customers.search({
    query: `metadata['user_id']:'${userId}'`,
    limit: 100,
  });
  return found.data.filter((customer) => !customer.deleted);
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
