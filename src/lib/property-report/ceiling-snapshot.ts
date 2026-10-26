import type { CeilingUserChoices } from "@/lib/bid-ceiling-defaults";
import {
  CEILING_PROFILES,
  CEILING_PROJECTS,
  ceilingsByWorks,
  estimatedFeeItems,
  evaluateBid,
} from "@/lib/bid-ceiling-engine";
import type { FeeRegimeKey } from "@/lib/fee-regime-open";
import { assessSaleCeilingInputs, computeSaleCeiling } from "@/lib/sale-ceiling";
import type { MarketEstimate } from "@/lib/market.server";
import { computeAcquisitionCosts, estimateWorksBudget } from "@/lib/profitability";
import type { AuctionSale } from "@/lib/types";

/** Why a saved report has no ceiling when the sale has no open fee regime. */
export const NO_CEILING_REGIME_REASON = "Pas d’enchère plafond pour ce type de vente";

/**
 * The bid ceiling saved in a report, computed with the same engine and the
 * same defaults as the sale page so the two never show different amounts.
 *
 * The server decides whether a ceiling exists: `regimes` are the fee regimes open on the server
 * (`openFeeRegimesFromEnv`, `CEILING_FEE_REGIMES_OPEN`). A sale whose fee regime is closed or absent
 * (domanial or unknown venue, notarial sale whose mode is unknown, regime switched off) gets no
 * ceiling (`available: false`, `NO_CEILING_REGIME_REASON`), whatever the caller sent. The other
 * guards of `computeSaleCeiling` (valuation conflict, AI review) are applied by the callers: the
 * report refuses a valuation conflict before building the snapshot.
 */
export function buildCeilingSnapshot(
  sale: AuctionSale,
  marketEstimate: MarketEstimate | null,
  choices: CeilingUserChoices = {},
  regimes: readonly FeeRegimeKey[],
) {
  const inputs = assessSaleCeilingInputs({
    sale,
    aiProjections: null,
    aiReviewStatus: "disabled",
    regimes,
  });
  const noRegime = inputs.regime == null;
  const { hypotheses, plan } = computeSaleCeiling({
    assessed: inputs,
    // Without a regime there is no value to compute a ceiling from: nothing is leaked from it.
    estimate: noRegime ? null : marketEstimate,
    choices,
    guarded: false,
  });
  // Sans régime, aucun montant dérivé du plan n'entre dans le rapport (plafond par type de travaux,
  // marge au prix de départ, budget, étapes) : le plan n'est pas un calcul de cette vente.
  const computed = !noRegime && plan.available;
  const available = computed && plan.reachable;
  const byWorks = computed ? ceilingsByWorks(hypotheses) : [];
  const startingPrice = Math.max(0, sale.starting_price_eur ?? 0);
  const atStart = computed ? evaluateBid(hypotheses, plan, startingPrice) : null;
  const surface = hypotheses.surface ?? 0;
  const ceilingFor = (key: string) => {
    const row = byWorks.find((item) => item.key === key);
    return row?.plan.reachable ? row.plan.maxBid : null;
  };

  return {
    version: 2 as const,
    project: hypotheses.project,
    projectLabel: CEILING_PROJECTS.find((item) => item.key === hypotheses.project)?.label ?? "",
    scenario: hypotheses.profile,
    profileLabel:
      hypotheses.customMarginPct != null
        ? "Personnalisé"
        : (CEILING_PROFILES.find((item) => item.key === hypotheses.profile)?.label ?? ""),
    available,
    reason: available
      ? null
      : noRegime
        ? NO_CEILING_REGIME_REASON
        : (plan.reason ?? "Aucune enchère rentable à ces hypothèses"),
    /** Fee regime of the sale (`null`: no ceiling) and the wording of its maximum amount. */
    regime: inputs.regime?.key ?? null,
    label:
      (inputs.regime ?? undefined)?.labels.ceilingSimulationLabel ?? "Enchère plafond (simulation)",
    /** What the fees do not cover (« Hors débours et formalités du notaire. »). */
    scopeNote: inputs.regime?.labels.planner.scopeNote ?? null,
    /** Notice a sale by offers must carry: the seller need not keep the best offer. */
    reserveNotice: inputs.regime?.labels.planner.reserveNotice ?? null,
    /** Fees that come from a default value and must be confirmed. */
    estimatedFees: noRegime ? [] : estimatedFeeItems(hypotheses),
    maxBid: available ? plan.maxBid : null,
    maxBidWithoutWorks: ceilingFor("aucun"),
    maxBidWithRefreshWorks: ceilingFor("rafraichissement"),
    refreshWorksBudget: estimateWorksBudget(hypotheses.surface, "rafraichissement"),
    works: { key: hypotheses.works.key, amount: hypotheses.works.amount },
    occupation: hypotheses.occupation.case,
    targetTotalCost: computed ? plan.budget : null,
    marketReferencePricePerM2:
      computed && surface > 0 ? Math.round((hypotheses.value.amount ?? 0) / surface) : null,
    safetyDiscountPct: computed ? plan.marginPct + plan.dataMarginPct : null,
    basisLabel:
      hypotheses.value.source === "saisie" ? "prix au m² saisi" : "valeur estimée Immojudis",
    marginTotal: atStart ? atStart.headroom : null,
    marginPerM2: atStart && surface > 0 ? Math.round(atStart.headroom / surface) : null,
    steps: computed
      ? plan.steps.map(({ key, label, amount, kind }) => ({ key, label, amount, kind }))
      : [],
    acquisition: computeAcquisitionCosts({
      price: startingPrice,
      works: hypotheses.works.amount,
      ...hypotheses.fees,
    }),
  };
}
