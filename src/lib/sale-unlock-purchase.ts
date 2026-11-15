import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  ANALYSIS_RECURRING_PRICE_CENTS,
  SALE_UNLOCK_PURCHASE_REFUSAL_CODES,
  type SaleUnlockPurchaseRefusalCode,
  UNIT_PURCHASE_DEDUCTION_WINDOW_DAYS,
} from "@/lib/analysis-offer";

/**
 * Achat du déblocage d'une vente à l'unité : les appels à la base (lot 3, 15/11/2026). La base
 * décide de tout (réservation, accord, crédit, déduction sur le premier mois) sous verrou ; ce
 * module ne fait que l'appeler avec le client de service. Aucun appel Stripe ici : la session et le
 * webhook sont dans `billing.ts`.
 *
 * Les fonctions et la table viennent de la migration `20261122100000_sale_unlock_purchases.sql` et ne
 * figurent pas encore dans les types générés (`src/integrations/supabase/types.ts`) : elles sont
 * appelées à travers `untypedAdmin` et leurs réponses sont lues par zod. Une fois les types régénérés,
 * `untypedAdmin` peut céder la place à `supabaseAdmin`.
 */

type RpcError = { message?: string; code?: string; details?: string | null };

/** Le client de service sans les types générés, pour les fonctions et la table pas encore typées. */
function untypedAdmin(): SupabaseClient {
  return supabaseAdmin as unknown as SupabaseClient;
}

function callRpc(name: string, args: Record<string, unknown>) {
  return untypedAdmin().rpc(name, args);
}

function rpcFailure(error: RpcError, fallback: string): Error {
  return new Error(error.message || fallback);
}

const REFUSAL_MESSAGES: Record<SaleUnlockPurchaseRefusalCode, string> = {
  analysis_access: "Votre offre Analyse donne déjà accès à toutes les ventes.",
  free_unlock_available:
    "Votre compte peut encore débloquer une vente gratuitement : utilisez d’abord ce déblocage.",
  credit_available:
    "Vous avez un crédit de déblocage : utilisez-le pour débloquer cette vente sans payer.",
  already_unlocked: "Cette vente est déjà débloquée sur votre compte.",
  sale_not_unlockable: "Cette vente n’est plus débloquable.",
};

/** Refus de la base, rendu en 409 `{ error, code }` par la route. */
export class SaleUnlockPurchaseRefusedError extends Error {
  readonly code: SaleUnlockPurchaseRefusalCode;

  constructor(code: SaleUnlockPurchaseRefusalCode) {
    super(REFUSAL_MESSAGES[code]);
    this.name = "SaleUnlockPurchaseRefusedError";
    this.code = code;
  }
}

function refusalCode(error: RpcError): SaleUnlockPurchaseRefusalCode | null {
  const detail = error.details?.trim();
  return (SALE_UNLOCK_PURCHASE_REFUSAL_CODES as readonly string[]).includes(detail ?? "")
    ? (detail as SaleUnlockPurchaseRefusalCode)
    : null;
}

const reservationSchema = z.object({
  purchase_id: z.string().uuid(),
  existing_session_id: z.string().nullable(),
});

/**
 * Réserve l'achat (ou retrouve la réservation en attente du compte pour cette vente). Un refus de la
 * base lève `SaleUnlockPurchaseRefusedError`.
 */
export async function reserveSaleUnlockPurchase(
  userId: string,
  saleId: string,
): Promise<{ purchaseId: string; existingSessionId: string | null }> {
  const { data, error } = await callRpc("reserve_sale_unlock_purchase", {
    p_user_id: userId,
    p_sale_id: saleId,
  });
  if (error) {
    const code = refusalCode(error);
    if (code) throw new SaleUnlockPurchaseRefusedError(code);
    throw rpcFailure(error, "Sale unlock purchase reservation failed.");
  }
  const row = reservationSchema.parse(Array.isArray(data) ? data[0] : data);
  return { purchaseId: row.purchase_id, existingSessionId: row.existing_session_id };
}

/**
 * Rattache la session (et la preuve d'acceptation) à l'achat en attente. Faux : l'achat n'est plus en
 * attente ou porte déjà une autre session ; l'appelant expire alors la sienne.
 */
export async function attachSaleUnlockCheckout(
  purchaseId: string,
  checkoutSessionId: string,
  commercialAcceptanceId: string,
): Promise<boolean> {
  const { data, error } = await callRpc("attach_sale_unlock_checkout", {
    p_purchase_id: purchaseId,
    p_checkout_session_id: checkoutSessionId,
    p_commercial_acceptance_id: commercialAcceptanceId,
  });
  if (error) throw rpcFailure(error, "Sale unlock checkout attachment failed.");
  return data === true;
}

const grantSchema = z.object({
  granted: z.boolean(),
  outcome: z.enum(["unlocked", "credit"]).nullable(),
});

export type SaleUnlockGrant = z.infer<typeof grantSchema>;

/**
 * La base refuse le paiement pour cet achat (autre compte, autre vente, autre session, autre montant)
 * ou ne connaît pas l'achat : refus définitif, que rejouer l'événement ne changerait pas.
 */
export class SaleUnlockGrantRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaleUnlockGrantRefusedError";
  }
}

/**
 * Accorde l'achat payé : déblocage de la vente, ou crédit si elle n'est plus débloquable. Idempotent :
 * un paiement déjà appliqué répond la même chose sans rien écrire. Refus définitif de la base :
 * `SaleUnlockGrantRefusedError` ; toute autre erreur se propage (le webhook est rejoué).
 */
export async function grantPurchasedSaleUnlock(args: {
  purchaseId: string;
  userId: string;
  saleId: string;
  checkoutSessionId: string;
  paymentIntentId: string;
  amountCents: number;
  currency: string;
  eventId: string;
  paidAt: string;
}): Promise<SaleUnlockGrant> {
  const { data, error } = await callRpc("grant_purchased_sale_unlock", {
    p_purchase_id: args.purchaseId,
    p_user_id: args.userId,
    p_sale_id: args.saleId,
    p_checkout_session_id: args.checkoutSessionId,
    p_payment_intent_id: args.paymentIntentId,
    p_amount_cents: args.amountCents,
    p_currency: args.currency,
    p_event_id: args.eventId,
    p_paid_at: args.paidAt,
  });
  if (error) {
    if (error.details === "sale_unlock_purchase_mismatch" || error.code === "P0002") {
      throw new SaleUnlockGrantRefusedError(error.message || "Sale unlock grant refused.");
    }
    throw rpcFailure(error, "Sale unlock grant failed.");
  }
  const row = Array.isArray(data) ? data[0] : data;
  return row ? grantSchema.parse(row) : { granted: false, outcome: null };
}

/**
 * Session d'achat expirée sans paiement : l'achat en attente de cette session passe à `expired`, et
 * le compte peut réserver de nouveau. Vrai quand un achat a été expiré.
 */
export async function expireSaleUnlockPurchase(checkoutSessionId: string): Promise<boolean> {
  const { data, error } = await callRpc("expire_sale_unlock_purchase", {
    p_checkout_session_id: checkoutSessionId,
  });
  if (error) throw rpcFailure(error, "Sale unlock purchase expiry failed.");
  return data === true;
}

export type SaleUnlockPaymentState = "refunded" | "disputed" | "dispute_lost" | "paid";

/** Remboursement ou litige d'un paiement unitaire : jamais l'abonnement (`user_subscriptions`). */
export async function recordSaleUnlockPaymentState(args: {
  paymentIntentId: string;
  state: SaleUnlockPaymentState;
  eventId: string;
  eventCreated: number;
}): Promise<boolean> {
  const { data, error } = await callRpc("record_sale_unlock_payment_state", {
    p_payment_intent_id: args.paymentIntentId,
    p_state: args.state,
    p_event_id: args.eventId,
    p_event_created: args.eventCreated,
  });
  if (error) throw rpcFailure(error, "Sale unlock payment state failed.");
  return data === true;
}

/**
 * Réserve, pour le checkout d'abonnement de jeton `token`, la déduction des achats à l'unité payés
 * depuis moins de 30 jours. Rend le montant en centimes (0 : rien à déduire), plafonné au prix du
 * premier mois.
 */
export async function reserveUnitPurchaseDeduction(
  userId: string,
  token: string,
  now: Date,
): Promise<number> {
  const { data, error } = await callRpc("reserve_unit_purchase_deduction", {
    p_user_id: userId,
    p_token: token,
    p_now: now.toISOString(),
  });
  if (error) throw rpcFailure(error, "Unit purchase deduction reservation failed.");
  const amount = z
    .number()
    .int()
    .nonnegative()
    .parse(data ?? 0);
  return Math.min(amount, ANALYSIS_RECURRING_PRICE_CENTS);
}

/** Checkout d'abonnement payé : la déduction réservée est acquise. */
export async function settleUnitPurchaseDeduction(
  token: string,
  checkoutSessionId: string,
): Promise<void> {
  const { error } = await callRpc("settle_unit_purchase_deduction", {
    p_token: token,
    p_checkout_session_id: checkoutSessionId,
  });
  if (error) throw rpcFailure(error, "Unit purchase deduction settlement failed.");
}

/** Checkout d'abonnement expiré ou abandonné : la déduction réservée est rendue. */
export async function releaseUnitPurchaseDeduction(token: string): Promise<void> {
  const { error } = await callRpc("release_unit_purchase_deduction", { p_token: token });
  if (error) throw rpcFailure(error, "Unit purchase deduction release failed.");
}

const purchaseAmountsSchema = z.array(z.object({ amount_cents: z.number().int().nonnegative() }));

/**
 * Aperçu, en lecture seule, de ce que `reserve_unit_purchase_deduction` déduirait maintenant du
 * premier mois : les achats `paid`, non déduits, payés depuis moins de 30 jours, plafonnés au prix du
 * mois. Lit la table `sale_unlock_purchases` par le client de service, faute de fonction de lecture
 * dans la base (même règle que la fonction, à garder alignée) ; la déduction réelle reste celle de la
 * base, au checkout. Le compte qui a déjà eu un abonnement
 * n'a pas de « premier mois » : l'appelant le vérifie.
 */
export async function previewUnitPurchaseDeductionCents(
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const since = new Date(now.getTime() - UNIT_PURCHASE_DEDUCTION_WINDOW_DAYS * 86_400_000);
  const { data, error } = await untypedAdmin()
    .from("sale_unlock_purchases")
    .select("amount_cents")
    .eq("user_id", userId)
    .eq("state", "paid")
    .is("deducted_checkout_session_id", null)
    .gt("paid_at", since.toISOString())
    .lte("paid_at", now.toISOString());
  if (error) throw rpcFailure(error, "Sale unlock purchases read failed.");
  const total = purchaseAmountsSchema
    .parse(data ?? [])
    .reduce((sum, row) => sum + row.amount_cents, 0);
  return Math.min(total, ANALYSIS_RECURRING_PRICE_CENTS);
}
