/**
 * Format des écarts de facturation, partagé par le rapprochement quotidien (`billing-reconciliation.ts`)
 * et le webhook (`billing-unit-deduction.ts`, écart au règlement d'une déduction). Types seulement :
 * les deux modules en dépendent sans dépendre l'un de l'autre.
 */
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
  | "user_mismatch"
  /** Session d'achat à l'unité payée chez Stripe, sans achat payé en base (déblocage non accordé). */
  | "sale_unlock_paid_without_purchase"
  /** Achat à l'unité déduit d'un premier mois d'abonnement, puis remboursé, contesté ou litige perdu. */
  | "sale_unlock_deducted_then_refunded"
  /**
   * Au paiement d'un premier mois, la base a réglé moins (ou plus) d'achats que le bon appliqué :
   * achat remboursé ou contesté entre le checkout et le paiement. Journalisé par le webhook.
   */
  | "unit_deduction_settlement_mismatch";

export type BillingDiscrepancy = {
  kind: BillingDiscrepancyKind;
  stripeSubscriptionId: string | null;
  userId: string | null;
  detail: string;
  /** Session Checkout en cause (achats à l'unité). */
  stripeCheckoutSessionId?: string | null;
};
