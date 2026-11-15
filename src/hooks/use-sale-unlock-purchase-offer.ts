import { useBillingOffer } from "@/hooks/use-billing-offer";
import { analysisOfferLabelAmountsCents, resolveAnalysisOfferLabel } from "@/lib/analysis-offer";
import type { SaleUnlockPurchaseOffer } from "@/lib/sale-unlocks";

/**
 * Ce que la fiche peut proposer à un compte gratuit dont le déblocage a servi : l'abonnement (s'il se
 * souscrit) et l'achat de la vente à l'unité (s'il est ouvert). Une seule lecture de l'offre pour les
 * deux. `loading` tant que l'offre n'est pas lue : rien n'est promis avant ; une offre illisible
 * compte comme fermée, comme pour `useAnalysisCheckoutOpen`.
 */
export type SaleUnlockPurchaseOfferState =
  | { status: "loading" }
  | {
      status: "ready";
      /** L'abonnement Analyse se souscrit vraiment. */
      analysisOpen: boolean;
      /** Libellé public de l'abonnement, « 59 € TTC / mois ». */
      analysisLabel: string;
      /** Prix mensuel lu dans ce libellé, en centimes ; `null` s'il ne s'y lit pas. */
      analysisCents: number | null;
      /** L'achat à l'unité ; `null` tant qu'il n'est pas ouvert. */
      purchase: Pick<SaleUnlockPurchaseOffer, "label" | "amountCents"> | null;
      firstMonthDeductionCents: number;
    };

export function useSaleUnlockPurchaseOffer(): SaleUnlockPurchaseOfferState {
  const { offer } = useBillingOffer();
  if (offer.status === "loading") return { status: "loading" };
  const ready = offer.status === "ready" ? offer : null;
  const analysisLabel = ready?.label ?? resolveAnalysisOfferLabel();
  return {
    status: "ready",
    analysisOpen: ready?.open === true,
    analysisLabel,
    analysisCents: analysisOfferLabelAmountsCents(analysisLabel)[0] ?? null,
    purchase: ready?.saleUnlock ?? null,
    firstMonthDeductionCents: ready?.firstMonthDeductionCents ?? 0,
  };
}
