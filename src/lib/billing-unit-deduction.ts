import "server-only";
import type Stripe from "stripe";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { ANALYSIS_RECURRING_CURRENCY } from "@/lib/analysis-offer";
import type { BillingDiscrepancy } from "@/lib/billing-discrepancy";
import { getUserSubscription, isStripeMissingOrCancelled } from "@/lib/billing-stripe";
import { serverEnv } from "@/lib/env";
import {
  previewUnitPurchaseDeductionCents,
  releaseUnitPurchaseDeduction,
  reserveUnitPurchaseDeduction,
  settleUnitPurchaseDeduction,
} from "@/lib/sale-unlock-purchase";

/**
 * Déduction des achats à l'unité sur le premier mois d'abonnement Analyse (lot 3) : réservation en
 * base et bon Stripe à la création du checkout d'abonnement, règlement à son paiement, libération à
 * son expiration ou en cas d'échec. Le checkout et le webhook de l'abonnement (`billing.ts`) appellent
 * ces fonctions ; la base calcule les montants.
 */

/** Déduction des achats à l'unité portée par un checkout d'abonnement : bon Stripe et montant. */
export type UnitPurchaseDeduction = { couponId: string; amountCents: number };

/** Métadonnées de la session d'abonnement qui portent la déduction (règlement, libération). */
export const UNIT_PURCHASE_DEDUCTION_COUPON_METADATA = "unit_purchase_deduction_coupon";
const UNIT_PURCHASE_DEDUCTION_CENTS_METADATA = "unit_purchase_deduction_cents";

/**
 * Réserve en base la déduction des achats à l'unité pour ce checkout et crée le bon Stripe qui la
 * porte : montant fixe en euros, valable une fois, limité au produit Analyse quand
 * `STRIPE_ANALYSIS_PRODUCT_ID` est posé. `null` : rien à déduire.
 */
export async function prepareUnitPurchaseDeduction(
  stripe: Stripe,
  userId: string,
  reservationToken: string,
): Promise<UnitPurchaseDeduction | null> {
  const amountCents = await reserveUnitPurchaseDeduction(userId, reservationToken, new Date());
  if (amountCents <= 0) return null;
  const productId = serverEnv().stripe.analysisProductId;
  const coupon = await stripe.coupons.create(
    {
      amount_off: amountCents,
      currency: ANALYSIS_RECURRING_CURRENCY,
      duration: "once",
      max_redemptions: 1,
      name: "Achats à l’unité déduits du premier mois",
      ...(productId ? { applies_to: { products: [productId] } } : {}),
      metadata: {
        user_id: userId,
        checkout_reservation_token: reservationToken,
        purpose: "unit_purchase_deduction",
      },
    },
    { idempotencyKey: `immojudis-unit-deduction-${reservationToken}` },
  );
  return { couponId: coupon.id, amountCents };
}

/**
 * Checkout d'abonnement expiré, abandonné ou en échec : la déduction réservée est rendue et son bon
 * supprimé chez Stripe (déjà supprimé : rien à faire).
 */
export async function releaseUnitPurchaseDeductionOf(
  stripe: Stripe,
  session: Pick<Stripe.Checkout.Session, "metadata">,
): Promise<void> {
  const token = session.metadata?.checkout_reservation_token;
  const couponId = session.metadata?.[UNIT_PURCHASE_DEDUCTION_COUPON_METADATA];
  if (!token || !couponId) return;
  await releaseUnitPurchaseDeduction(token);
  try {
    await stripe.coupons.del(couponId);
  } catch (error) {
    if (!isStripeMissingOrCancelled(error)) throw error;
  }
}

/** Champs de la session d'abonnement qui portent la déduction : seule remise de la session. */
export function unitPurchaseDeductionSessionFields(deduction: UnitPurchaseDeduction | null): {
  discounts?: Stripe.Checkout.SessionCreateParams.Discount[];
  metadata: Record<string, string>;
} {
  if (!deduction) return { metadata: {} };
  return {
    discounts: [{ coupon: deduction.couponId }],
    metadata: {
      [UNIT_PURCHASE_DEDUCTION_COUPON_METADATA]: deduction.couponId,
      [UNIT_PURCHASE_DEDUCTION_CENTS_METADATA]: String(deduction.amountCents),
    },
  };
}

/**
 * Checkout d'abonnement en échec à sa création : la déduction réservée par son jeton est rendue (même
 * si le bon n'a pas pu être créé) et le bon supprimé. Jamais d'erreur : l'échec du checkout prime.
 */
export async function abandonUnitPurchaseDeduction(
  stripe: Stripe,
  reservationToken: string,
  deduction: UnitPurchaseDeduction | null,
): Promise<void> {
  await releaseUnitPurchaseDeduction(reservationToken).catch(() => undefined);
  if (deduction) await stripe.coupons.del(deduction.couponId).catch(() => undefined);
}

/**
 * Checkout d'abonnement payé avec le bon : la déduction réservée est acquise. La base rend ce qu'elle a
 * réellement réglé (achats encore payés) ; un écart avec le montant du bon (achat remboursé ou
 * contesté entre le checkout et le paiement) est journalisé au format du rapprochement, pour une
 * décision humaine. Une erreur de la base se propage (le webhook est rejoué).
 */
export async function settleUnitPurchaseDeductionOf(
  session: Pick<Stripe.Checkout.Session, "id" | "metadata" | "client_reference_id">,
): Promise<void> {
  const token = session.metadata?.checkout_reservation_token;
  if (!token || !session.metadata?.[UNIT_PURCHASE_DEDUCTION_COUPON_METADATA]) return;
  const settledCents = await settleUnitPurchaseDeduction(token, session.id);
  const couponCents = Number(session.metadata[UNIT_PURCHASE_DEDUCTION_CENTS_METADATA]);
  if (settledCents === couponCents) return;
  const discrepancy: BillingDiscrepancy = {
    kind: "unit_deduction_settlement_mismatch",
    stripeSubscriptionId: null,
    stripeCheckoutSessionId: session.id,
    userId: session.metadata.user_id || session.client_reference_id || null,
    detail: `Bon de ${Number.isFinite(couponCents) ? couponCents : "(inconnu)"} centimes appliqué au premier mois, ${settledCents} centimes d'achats encore payés réglés en base.`,
  };
  console.error("[billing] unit purchase deduction settlement mismatch", discrepancy);
}

/**
 * Ce qui serait déduit du premier mois d'abonnement pour ce compte s'il souscrivait maintenant
 * (lecture seule, pour `/api/billing/offer`). Un compte qui a déjà eu un abonnement Stripe n'a pas de
 * premier mois : 0. Le checkout refait le calcul en base et lit l'historique chez Stripe.
 */
export async function previewFirstMonthDeductionCents(auth: SupabaseAuthContext): Promise<number> {
  const subscription = await getUserSubscription(auth);
  if (subscription?.stripe_subscription_id) return 0;
  return previewUnitPurchaseDeductionCents(auth.userId);
}
