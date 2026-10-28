// Frais d'acquisition du rendement brut d'une vente (filtre « rendement minimal », alertes, export, statistiques,
// rapport) : ceux du RÉGIME de la vente, comme le plafond et le rapport (`ceiling-snapshot.ts`), et non ceux du
// tribunal pour toutes les ventes. Une vente notariale n'a ni frais préalables ni avocat poursuivant : son barème
// est celui du notaire (bougie : adjudication volontaire plus frais d'organisation ; vente interactive : gré à gré
// plus honoraires de négociation et publicité de l'acquéreur lus dans l'annonce).
//
// Module léger, lu par le navigateur : il n'importe que les barèmes (`fee-regime-notary-scale.ts`) et la clé du
// régime (`fee-regime-key.ts`), jamais les textes des régimes. Régime inconnu, fermé ou vente domaniale : frais du
// tribunal par défaut, comme le plafond (`hypotheses.fees` sans régime).
import {
  NOTARY_AUCTION_EMOLUMENT_BRACKETS,
  NOTARY_AUCTION_ORGANIZATION_FEE_RATE,
  NOTARY_ONLINE_EMOLUMENT_BRACKETS,
} from "@/lib/fee-regime-notary-scale";
import { feeRegimeKeyForSale } from "@/lib/fee-regime-key";
import type { FeeRegimeKey } from "@/lib/fee-regime-open";
import { readNotarySaleConditions } from "@/lib/notary-sale-conditions";
import type { AcquisitionCostOptions } from "@/lib/profitability";
import type { AuctionSale } from "@/lib/types";

/** Les options de coût d'acquisition du régime de la vente (sans prix ni département) ; `{}` : frais du tribunal. */
export function saleYieldFeeOptions(
  sale: Partial<AuctionSale>,
  open?: readonly FeeRegimeKey[],
): AcquisitionCostOptions {
  const key = feeRegimeKeyForSale(sale as AuctionSale, open);
  if (key === "notary_auction") {
    return {
      fpt: 0,
      lawyerFees: 0,
      emolumentBrackets: NOTARY_AUCTION_EMOLUMENT_BRACKETS,
      organizationFeeRate: NOTARY_AUCTION_ORGANIZATION_FEE_RATE,
    };
  }
  if (key === "notary_online") {
    // Même lecture que le plafond (`buyerFeesHypothesis`) : le vendeur paie ses honoraires, sinon le taux lu
    // (0 s'il n'est pas indiqué) ; publicité de l'annonce, sinon 0.
    const conditions = readNotarySaleConditions(sale as AuctionSale);
    const payer = conditions?.negotiationFeePayer ?? null;
    return {
      fpt: 0,
      lawyerFees: 0,
      emolumentBrackets: NOTARY_ONLINE_EMOLUMENT_BRACKETS,
      negotiationFeeRate: payer === "VENDEUR" ? 0 : (conditions?.negotiationFeeRate ?? 0),
      advertisingFees: conditions?.advertisingFeesEur ?? 0,
    };
  }
  return {};
}
