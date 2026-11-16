import { analysisCheckoutReadiness } from "@/lib/analysis-checkout-readiness";
import { PublicApiError } from "@/lib/api-errors";
import { serverEnv } from "@/lib/env";

/**
 * Définition unique de « l'achat d'une vente à l'unité est ouvert » (lot 3, 15/11/2026).
 *
 * L'achat reprend la configuration des paiements Analyse (`analysisCheckoutReadiness` : clé Stripe du
 * mode du déploiement, secret de webhook, identité légale, canal de confirmation) sans son
 * interrupteur de vente : fermer la souscription Analyse ne ferme pas l'achat à l'unité. Il exige en
 * plus son propre Price (`STRIPE_SALE_UNLOCK_PRICE_ID`) et son interrupteur
 * `STRIPE_SALE_UNLOCK_SALES_OPEN`, FERMÉ par défaut, comme `STRIPE_ANALYSIS_SALES_OPEN` depuis le
 * 16/11/2026. Même format de valeur : seule `true` (casse indifférente) ouvre.
 * Module sans accès à la base ni à Stripe.
 */
export type SaleUnlockCheckoutReadiness = {
  /** Vrai seulement si rien ne manque, si la clé est du bon mode et si l'interrupteur vaut `true`. */
  open: boolean;
  /** Variables d'environnement absentes ou invalides (celles des paiements Analyse comprises). */
  missing: string[];
  /** Clé Stripe d'un autre mode que le déploiement (voir `analysisCheckoutReadiness`). */
  keyModeMismatch: boolean;
  /** L'interrupteur `STRIPE_SALE_UNLOCK_SALES_OPEN` ne vaut pas `true`. */
  salesClosed: boolean;
};

/**
 * Price de l'achat à l'unité (`STRIPE_SALE_UNLOCK_PRICE_ID`) s'il a la forme d'un Price Stripe
 * (`price_…`) ; `undefined` s'il est absent ou mal formé. Seule lecture de la variable.
 */
export function saleUnlockPriceId(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): string | undefined {
  const priceId = serverEnv(env).stripe.saleUnlockPriceId;
  return priceId && /^price_[A-Za-z0-9]+$/.test(priceId) ? priceId : undefined;
}

function saleUnlockSalesOpen(env: Pick<NodeJS.ProcessEnv, string>): boolean {
  return serverEnv(env).stripe.saleUnlockSalesOpen?.toLowerCase() === "true";
}

export function saleUnlockCheckoutReadiness(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): SaleUnlockCheckoutReadiness {
  const payments = analysisCheckoutReadiness(env);
  const missing = [
    ...payments.missing,
    ...(saleUnlockPriceId(env) ? [] : ["STRIPE_SALE_UNLOCK_PRICE_ID"]),
  ];
  const salesClosed = !saleUnlockSalesOpen(env);
  return {
    open: missing.length === 0 && !payments.keyModeMismatch && !salesClosed,
    missing,
    keyModeMismatch: payments.keyModeMismatch,
    salesClosed,
  };
}

export const SALE_UNLOCK_CHECKOUT_CLOSED_MESSAGE =
  "L’achat du déblocage d’une vente n’est pas ouvert pour le moment.";

/**
 * Garde de la création d'une session d'achat : fermée, quelle qu'en soit la raison, elle répond 503
 * avec un message pour le client (le détail de la configuration reste dans les journaux et le
 * panneau d'administration).
 */
export function assertSaleUnlockCheckoutOpen(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): void {
  if (!saleUnlockCheckoutReadiness(env).open) {
    throw new PublicApiError(SALE_UNLOCK_CHECKOUT_CLOSED_MESSAGE, 503);
  }
}
