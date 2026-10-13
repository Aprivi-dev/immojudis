import { fetchBillingOffer } from "@/lib/client-billing";
import { legalPublisherConfigurationStatus } from "@/lib/legal-documents";

/**
 * Whether the Analyse subscription can be bought right now, asked at the moment a locked feature
 * is used. Envoyer la personne vers `/offres` quand l'abonnement est fermé la mène dans une
 * impasse : l'appelant affiche alors un message à la place. Any doubt (legal identity missing,
 * network error) counts as closed.
 */
export async function isAnalysisOfferOpen(): Promise<boolean> {
  if (!legalPublisherConfigurationStatus().ready) return false;
  try {
    return (await fetchBillingOffer()).configured === true;
  } catch {
    return false;
  }
}
