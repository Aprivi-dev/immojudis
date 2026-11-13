import { useBillingOffer } from "@/hooks/use-billing-offer";

/**
 * Whether the Analyse subscription can really be bought today. `null` while this is still unknown,
 * so no trial is promised before it is verified; an offer that cannot be read counts as closed.
 */
export function useAnalysisCheckoutOpen(): boolean | null {
  const { offer } = useBillingOffer();
  if (offer.status === "loading") return null;
  return offer.status === "ready" && offer.open;
}
