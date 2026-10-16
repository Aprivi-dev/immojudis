import {
  computeAcquisitionCosts,
  type AcquisitionCostOptions,
  type AcquisitionCostResult,
} from "@/lib/profitability";
import { MAX_SIMULATOR_AMOUNT_EUR } from "@/lib/simulator-limits";

/** Plafond du budget accepté (voir `simulator-limits.ts`). */
export const MAX_BID_BUDGET_EUR = MAX_SIMULATOR_AMOUNT_EUR;

/**
 * Nombre maximal de tours de dichotomie. Sous le plafond, 34 tours suffisent (2^34 > 1e10) ; la
 * borne est une sécurité : la boucle ne peut jamais tourner sans fin, quelle que soit l'entrée.
 */
const MAX_BISECTION_STEPS = 64;

/**
 * Mode inverse du simulateur de frais : « j'ai un budget total de X € : jusqu'à combien
 * enchérir ? ».
 *
 * Aucun barème n'est recopié ici : le coût total d'un prix d'adjudication vient uniquement de
 * `computeAcquisitionCosts` (émoluments, droits de mutation, CSI, frais préalables, honoraires,
 * travaux), avec les mêmes hypothèses que le simulateur direct. On cherche le plus grand prix
 * entier `p` tel que `computeAcquisitionCosts({ price: p, ... }).totalCost <= budget`.
 *
 * La recherche par dichotomie est valable parce que le coût total est strictement croissant avec le
 * prix : chaque tranche d'émoluments et les droits proportionnels ne font que croître avec lui.
 */
export type BudgetInversion =
  /** Budget absent, nul, négatif ou non numérique. */
  | { status: "invalid" }
  /** Budget au-dessus de `MAX_BID_BUDGET_EUR` : aucun calcul n'est tenté. */
  | { status: "too_high"; budget: number; maximumBudget: number }
  /** Le budget ne couvre pas les frais fixes (honoraires, frais préalables, travaux…) à prix nul. */
  | { status: "too_low"; budget: number; minimumBudget: number }
  | {
      status: "ok";
      budget: number;
      /** Plus grand prix d'adjudication entier (euros) que le budget couvre, frais compris. */
      maxPrice: number;
      /** Détail des frais à ce prix, produit par le moteur de frais. */
      costs: AcquisitionCostResult;
      /** Part du budget non consommée à ce prix : toujours inférieure au prix d'un euro de plus. */
      remaining: number;
    };

export type BudgetInversionOptions = AcquisitionCostOptions;

export function maxPriceForBudget(
  budget: number,
  options: BudgetInversionOptions = {},
): BudgetInversion {
  if (!Number.isFinite(budget) || budget <= 0) return { status: "invalid" };
  if (budget > MAX_BID_BUDGET_EUR) {
    return { status: "too_high", budget, maximumBudget: MAX_BID_BUDGET_EUR };
  }

  const costAt = (price: number) => computeAcquisitionCosts({ ...options, price });
  const fits = (price: number) => costAt(price).totalCost <= budget;

  if (!fits(0)) {
    return { status: "too_low", budget, minimumBudget: costAt(0).totalCost };
  }

  // Invariant : `low` tient dans le budget. `high` est un majorant : le prix seul ne peut pas
  // dépasser le budget, les frais s'y ajoutent.
  let low = 0;
  let high = Math.floor(budget);
  if (fits(high)) {
    low = high;
  } else {
    for (let step = 0; high - low > 1 && step < MAX_BISECTION_STEPS; step += 1) {
      const middle = Math.floor((low + high) / 2);
      if (fits(middle)) low = middle;
      else high = middle;
    }
  }

  const costs = costAt(low);
  return {
    status: "ok",
    budget,
    maxPrice: low,
    costs,
    remaining: budget - costs.totalCost,
  };
}
