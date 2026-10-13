import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { fetchBillingOffer } from "@/lib/client-billing";
import { legalPublisherConfigurationStatus } from "@/lib/legal-documents";

/**
 * What the page knows about the Analyse offer.  `loading` and `error` are kept
 * apart from a closed offer: a slow or failed request must never read as
 * "subscriptions are not open".
 */
export type BillingOfferState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      /** Stripe price configured on the server. */
      configured: boolean;
      /** Configured and the legal identity published: the subscription can really be bought. */
      open: boolean;
      trialAvailable: boolean;
      label: string | null;
    };

export type BillingOfferSource = {
  offer: BillingOfferState;
  reload: () => void;
};

/**
 * Reads the public offer once.  /offres calls it once and hands the result to
 * `BillingActions`, which then skips its own request (`enabled: false`).
 */
export function useBillingOffer(enabled = true): BillingOfferSource {
  const { user, loading } = useAuth();
  const userId = user?.id ?? null;
  const [offer, setOffer] = useState<BillingOfferState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    // The trial eligibility depends on the account: wait for the session instead of
    // asking first as an anonymous visitor and again once signed in.
    if (loading) return;
    let active = true;
    setOffer({ status: "loading" });
    fetchBillingOffer()
      .then((response) => {
        if (!active) return;
        setOffer({
          status: "ready",
          configured: response.configured,
          open: response.configured && legalPublisherConfigurationStatus().ready,
          trialAvailable: response.trialAvailable !== false,
          label: response.label ?? null,
        });
      })
      .catch(() => {
        if (active) setOffer({ status: "error" });
      });
    return () => {
      active = false;
    };
  }, [enabled, loading, userId, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { offer, reload };
}
