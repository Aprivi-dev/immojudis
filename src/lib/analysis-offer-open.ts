import type { BillingOfferResponse } from "@/lib/client-billing";
import { legalPublisherConfigurationStatus } from "@/lib/legal-documents";

/**
 * L'abonnement Analyse peut-il vraiment être souscrit : le prix Stripe approuvé est configuré sur le
 * serveur et l'identité légale de l'éditeur est publiée. Ce que vaut une offre illisible (fermée, ou
 * une erreur à part) reste le choix de l'appelant.
 */
export function analysisOfferOpen(offer: Pick<BillingOfferResponse, "configured">): boolean {
  return offer.configured === true && legalPublisherConfigurationStatus().ready;
}
