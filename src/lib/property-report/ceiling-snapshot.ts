import type { CeilingUserChoices } from "@/lib/bid-ceiling-defaults";
import {
  CEILING_PROFILES,
  CEILING_PROJECTS,
  ceilingsByWorks,
  evaluateBid,
} from "@/lib/bid-ceiling-engine";
import { computeSaleCeiling } from "@/lib/sale-ceiling";
import type { MarketEstimate } from "@/lib/market.server";
import { computeAcquisitionCosts, estimateWorksBudget } from "@/lib/profitability";
import type { AuctionSale } from "@/lib/types";

/**
 * The bid ceiling saved in a report, computed with the same engine and the
 * same defaults as the sale page so the two never show different amounts.
 * The report route has already decided that a ceiling makes sense for the sale, so the guards of
 * `computeSaleCeiling` (fee regime, valuation conflict, AI review) are not applied again here.
 */
export function buildCeilingSnapshot(
  sale: AuctionSale,
  marketEstimate: MarketEstimate | null,
  choices: CeilingUserChoices = {},
) {
  const { hypotheses, plan } = computeSaleCeiling({
    sale,
    estimate: marketEstimate,
    aiProjections: null,
    aiReviewStatus: "disabled",
    choices,
    guarded: false,
  });
  const available = plan.available && plan.reachable;
  const byWorks = plan.available ? ceilingsByWorks(hypotheses) : [];
  const startingPrice = Math.max(0, sale.starting_price_eur ?? 0);
  const atStart = plan.available ? evaluateBid(hypotheses, plan, startingPrice) : null;
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
    reason: available ? null : (plan.reason ?? "Aucune enchère rentable à ces hypothèses"),
    maxBid: available ? plan.maxBid : null,
    maxBidWithoutWorks: ceilingFor("aucun"),
    maxBidWithRefreshWorks: ceilingFor("rafraichissement"),
    refreshWorksBudget: estimateWorksBudget(hypotheses.surface, "rafraichissement"),
    works: { key: hypotheses.works.key, amount: hypotheses.works.amount },
    occupation: hypotheses.occupation.case,
    targetTotalCost: plan.available ? plan.budget : null,
    marketReferencePricePerM2:
      plan.available && surface > 0 ? Math.round((hypotheses.value.amount ?? 0) / surface) : null,
    safetyDiscountPct: plan.available ? plan.marginPct + plan.dataMarginPct : null,
    basisLabel:
      hypotheses.value.source === "saisie" ? "prix au m² saisi" : "valeur estimée Immojudis",
    marginTotal: atStart ? atStart.headroom : null,
    marginPerM2: atStart && surface > 0 ? Math.round(atStart.headroom / surface) : null,
    steps: plan.steps.map(({ key, label, amount, kind }) => ({ key, label, amount, kind })),
    acquisition: computeAcquisitionCosts({
      price: startingPrice,
      works: hypotheses.works.amount,
      ...hypotheses.fees,
    }),
  };
}
