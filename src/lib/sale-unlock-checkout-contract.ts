/**
 * Contrat de `POST /api/billing/sale-unlock-checkout`, partagé par le serveur et le navigateur sans
 * rien charger d'autre : codes de refus, corps du 409, consentement, paramètre de retour de Stripe.
 * Le module d'appel (`client-sale-unlock-checkout.ts`) n'est chargé que par le bloc d'achat de la
 * fiche, jamais par les pages qui chargent `client-billing.ts`.
 */

/**
 * Refus de la réservation d'un achat à l'unité (`reserve_sale_unlock_purchase`), rendus tels quels
 * par la route (409 `{ error, code }`) : le compte a Analyse, a encore son déblocage gratuit ou un
 * crédit, la vente est déjà débloquée ou n'est plus débloquable.
 */
export const SALE_UNLOCK_PURCHASE_REFUSAL_CODES = [
  "analysis_access",
  "free_unlock_available",
  "credit_available",
  "already_unlocked",
  "sale_not_unlockable",
] as const;

export type SaleUnlockPurchaseRefusalCode = (typeof SALE_UNLOCK_PURCHASE_REFUSAL_CODES)[number];

/** Corps du 409 de `POST /api/billing/sale-unlock-checkout` : la base refuse l'achat. */
export type SaleUnlockCheckoutRefusal = { error: string; code: SaleUnlockPurchaseRefusalCode };

/**
 * Consentement de l'achat d'une vente à l'unité : celui de l'abonnement, plus la renonciation
 * expresse au droit de rétractation (contenu numérique fourni immédiatement).
 */
export type SaleUnlockCheckoutConsent = {
  termsAccepted: true;
  termsVersion: string;
  privacyVersion: string;
  paymentObligationAcknowledged: true;
  immediatePerformanceRequested: true;
  withdrawalInformationAcknowledged: true;
  withdrawalWaiverAcknowledged: true;
};

/**
 * Paramètre de la fiche de la vente au retour de Stripe Checkout : `success` ou `cancelled`. La
 * fiche ne fait que relire l'état du déblocage : seul le webhook l'accorde.
 */
export const SALE_UNLOCK_CHECKOUT_RETURN_PARAM = "unlock_checkout";

/** Code de refus d'une erreur levée par `startSaleUnlockCheckout` (409), ou `null`. */
export function saleUnlockCheckoutRefusalCode(
  error: unknown,
): SaleUnlockPurchaseRefusalCode | null {
  const { status, code } = (error ?? {}) as { status?: unknown; code?: unknown };
  return status === 409 && (SALE_UNLOCK_PURCHASE_REFUSAL_CODES as readonly unknown[]).includes(code)
    ? (code as SaleUnlockPurchaseRefusalCode)
    : null;
}
