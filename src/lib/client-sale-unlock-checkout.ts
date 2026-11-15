import type { BillingSessionResponse } from "@/lib/billing-stripe";
import { authHeaders, readJson } from "@/lib/client-api-core";
import type { SaleUnlockCheckoutConsent } from "@/lib/sale-unlock-checkout-contract";

/**
 * Ouvre la session de paiement du déblocage de la vente ; rend `{ url }` (page Stripe Checkout). En
 * échec, l'erreur levée porte `status` et `code` : 409 avec un code de refus (voir
 * `saleUnlockCheckoutRefusalCode`), 503 quand l'achat n'est pas ouvert. Au retour, la fiche porte
 * `?unlock_checkout=success` ou `=cancelled` et ne fait que relire l'état : le déblocage vient du
 * webhook Stripe. Hors de `client-billing.ts`, chargé partout : seul le bloc d'achat l'importe.
 */
export async function startSaleUnlockCheckout(args: {
  saleId: string;
  consent: SaleUnlockCheckoutConsent;
}): Promise<BillingSessionResponse> {
  const response = await fetch("/api/billing/sale-unlock-checkout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ saleId: args.saleId, consent: args.consent }),
  });

  return readJson<BillingSessionResponse>(response);
}
