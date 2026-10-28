import {
  DEFAULT_OPEN_FEE_REGIMES,
  isFeeRegimeOpen,
  type FeeRegimeKey,
} from "@/lib/fee-regime-open";
import { asRecord } from "@/lib/guards";
import { CEILING_SWITCHED_OFF_REASON } from "./ceiling-snapshot";

/**
 * Interrupteur par régime (`CEILING_FEE_REGIMES_OPEN`) au rendu d'un rapport enregistré.
 *
 * Un rapport garde son plafond tel qu'il a été calculé, avec le régime de frais de la vente
 * (`ceiling_snapshot.regime`). Quand l'exploitant ferme ce régime, le PDF et la page partagée ne
 * montrent plus ce plafond : « indisponible », montants masqués. Un rapport antérieur aux régimes
 * (`regime` absent) est un rapport du tribunal, toujours ouvert ; `regime: null` est déjà un rapport
 * sans plafond.
 */
export function isClosedCeilingRegime(
  ceiling: Record<string, unknown>,
  regimes: readonly FeeRegimeKey[] = DEFAULT_OPEN_FEE_REGIMES,
): boolean {
  const key = ceiling.regime;
  return typeof key === "string" && !isFeeRegimeOpen(key as FeeRegimeKey, regimes);
}

/** Le plafond du rapport tel qu'il doit être rendu : inchangé, ou masqué quand son régime est fermé. */
export function ceilingForOpenRegimes(
  ceiling: Record<string, unknown>,
  regimes: readonly FeeRegimeKey[] = DEFAULT_OPEN_FEE_REGIMES,
): Record<string, unknown> {
  if (!isClosedCeilingRegime(ceiling, regimes)) return ceiling;
  // `personalSimulation` (scénario saisi pour ce plafond) et le détail du calcul ne sont plus rendus.
  const { personalSimulation: _simulation, ...rest } = ceiling;
  return {
    ...rest,
    available: false,
    reason: CEILING_SWITCHED_OFF_REASON,
    maxBid: null,
    maxBidWithoutWorks: null,
    maxBidWithRefreshWorks: null,
    targetTotalCost: null,
    marketReferencePricePerM2: null,
    safetyDiscountPct: null,
    marginTotal: null,
    marginPerM2: null,
    steps: [],
    estimatedFees: [],
    scopeNote: null,
    reserveNotice: null,
  };
}

/**
 * L'analyse du rapport (`snapshot.analysis`) répète le plafond dans `opportunity.bidCeiling` : le
 * montant y est masqué lui aussi quand le régime du plafond est fermé.
 */
export function analysisForOpenRegimes(
  analysis: Record<string, unknown>,
  ceiling: Record<string, unknown>,
  regimes: readonly FeeRegimeKey[] = DEFAULT_OPEN_FEE_REGIMES,
): Record<string, unknown> {
  if (!isClosedCeilingRegime(ceiling, regimes)) return analysis;
  const opportunity = asRecord(analysis.opportunity);
  if (!("bidCeiling" in opportunity)) return analysis;
  return {
    ...analysis,
    opportunity: {
      ...opportunity,
      bidCeiling: {
        available: false,
        maxBid: null,
        targetTotalCost: null,
        marginTotal: null,
        marginPerM2: null,
      },
    },
  };
}
