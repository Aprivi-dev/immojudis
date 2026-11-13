import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { analysisOfferOpen } from "@/lib/analysis-offer-open";
import { fetchBillingOffer } from "@/lib/client-billing";

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
 * Reads the public offer once. /offres calls it once and hands the result to `BillingActions`,
 * which then skips its own request (`enabled: false`). Simple React state, not React Query: this
 * hook is in the first JavaScript of the home page and of /offres, which do not load React Query's
 * observers otherwise (11 Ko each, measured on 13/11/2026).
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
          open: analysisOfferOpen(response),
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

/**
 * Whether the Analyse subscription can be bought, asked at the moment a locked feature is used.
 * Envoyer la personne vers `/offres` quand l'abonnement est fermé la mène dans une impasse :
 * l'appelant affiche alors un message à la place. An offer that cannot be read counts as closed.
 */
export async function isAnalysisOfferOpen(): Promise<boolean> {
  try {
    return analysisOfferOpen(await fetchBillingOffer());
  } catch {
    return false;
  }
}
