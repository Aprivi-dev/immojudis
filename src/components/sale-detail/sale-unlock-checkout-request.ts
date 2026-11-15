import type { SaleUnlockConsent } from "@/lib/commercial-acceptance";
import { authHeaders, readJson } from "@/lib/client-api-core";

/*
 * PROVISOIRE (lot 3, zone C) : l'appel de `POST /api/billing/sale-unlock-checkout` doit venir de
 * `src/lib/client-billing.ts` (zone B). Ce module le remplace tant qu'il n'y est pas ; le retirer dès
 * qu'il y est, et importer le leur dans `SaleUnlockPurchaseChoices`. Le consentement est le type que
 * la route valide (`saleUnlockConsentSchema`, import de type seulement : rien du serveur n'est
 * embarqué).
 */

/**
 * Ouvre le paiement Stripe de la vente. Un refus lève l'erreur de `readJson` : son `status` (409,
 * 503) et son `code` (`SaleUnlockPurchaseRefusalCode` pour un 409) disent pourquoi.
 */
export async function startSaleUnlockCheckout(args: {
  saleId: string;
  consent: SaleUnlockConsent;
}): Promise<{ url: string }> {
  const response = await fetch("/api/billing/sale-unlock-checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ saleId: args.saleId, consent: args.consent }),
  });
  return readJson<{ url: string }>(response);
}
