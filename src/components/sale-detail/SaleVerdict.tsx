import {
  ceilingConfidence,
  type CeilingHypotheses,
  type CeilingPlan,
} from "@/lib/bid-ceiling-engine";
import type { FeeRegimeLabels } from "@/lib/fee-regime-definitions";
import { saleVerdict } from "@/lib/sale-verdict";
import type { AuctionSale } from "@/lib/types";
import styles from "./SaleListing.module.css";

/**
 * « La vente en une phrase », sous le titre de la fiche (`saleVerdict`). À n'afficher que lorsque le
 * plafond est chiffré et montré : l'appelant en décide.
 */
export function SaleVerdict({
  sale,
  startingPrice,
  plan,
  hypotheses,
  labels,
}: {
  sale: Pick<AuctionSale, "occupancy_status" | "risks">;
  startingPrice: number | null;
  plan: Pick<CeilingPlan, "startingPriceGap">;
  hypotheses: CeilingHypotheses;
  /** Les mots du régime de la vente ; absents : ceux du tribunal. */
  labels?: Pick<FeeRegimeLabels, "ceilingTerm" | "referencePriceTerm">;
}) {
  const verdict = saleVerdict({
    occupancyStatus: sale.occupancy_status,
    startingPrice,
    startingPriceGap: plan.startingPriceGap,
    ceilingTerm: labels?.ceilingTerm,
    referencePriceTerm: labels?.referencePriceTerm,
    risks: sale.risks,
    confidence: ceilingConfidence(hypotheses).label,
  });
  if (!verdict) return null;
  return (
    <p className={styles.verdict} data-testid="sale-verdict">
      <span>En une phrase</span>
      {verdict}
    </p>
  );
}
