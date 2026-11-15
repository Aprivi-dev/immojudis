import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { analysisOfferOpen } from "@/lib/analysis-offer-open";
import { fetchBillingOffer, type BillingOfferResponse } from "@/lib/client-billing";
import { legalPublisherConfigurationStatus } from "@/lib/legal-documents";
import type { SaleUnlockPurchaseOffer } from "@/lib/sale-unlocks";

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
      /**
       * Achat d'une vente à l'unité, seulement quand il peut vraiment se faire (ouvert sur le serveur,
       * identité légale publiée, montant lisible) ; `null` sinon : rien ne le propose.
       */
      saleUnlock: Pick<SaleUnlockPurchaseOffer, "label" | "amountCents"> | null;
      /** Ce que le serveur déduirait du premier mois d'abonnement (compte connecté) ; 0 sinon. */
      firstMonthDeductionCents: number;
    };

export type BillingOfferSource = {
  offer: BillingOfferState;
  reload: () => void;
};

/**
 * PROVISOIRE : les deux champs que la zone B ajoute à la réponse de `GET /api/billing/offer`. À
 * retirer quand `BillingOfferResponse` (`src/lib/client-billing.ts`) les déclare.
 */
type OfferWithSaleUnlock = BillingOfferResponse & {
  saleUnlock?: SaleUnlockPurchaseOffer | null;
  firstMonthDeductionCents?: number | null;
};

/** L'achat à l'unité se propose : ouvert, éditeur identifié (comme l'abonnement), montant lisible. */
function openSaleUnlockPurchase(
  response: OfferWithSaleUnlock,
): Pick<SaleUnlockPurchaseOffer, "label" | "amountCents"> | null {
  const offer = response.saleUnlock;
  if (offer?.open !== true || !legalPublisherConfigurationStatus().ready) return null;
  const label = typeof offer.label === "string" ? offer.label.trim() : "";
  if (!label || !Number.isInteger(offer.amountCents) || offer.amountCents <= 0) return null;
  return { label, amountCents: offer.amountCents };
}

function firstMonthDeduction(response: OfferWithSaleUnlock): number {
  const cents = response.firstMonthDeductionCents;
  return typeof cents === "number" && Number.isInteger(cents) && cents > 0 ? cents : 0;
}

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
          saleUnlock: openSaleUnlockPurchase(response),
          firstMonthDeductionCents: firstMonthDeduction(response),
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
