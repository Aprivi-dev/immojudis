import { useEffect, useState } from "react";
import { fetchBillingOffer } from "@/lib/client-billing";
import { legalPublisherConfigurationStatus } from "@/lib/legal-documents";

/**
 * Whether the Analyse subscription can really be bought today: the legal
 * identity is published and the approved Stripe price is configured. `null`
 * while this is still unknown, so no trial is promised before it is verified.
 */
export function useAnalysisCheckoutOpen(): boolean | null {
  const [open, setOpen] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    if (!legalPublisherConfigurationStatus().ready) {
      setOpen(false);
      return;
    }
    fetchBillingOffer()
      .then((offer) => {
        if (active) setOpen(offer.configured);
      })
      .catch(() => {
        if (active) setOpen(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return open;
}
