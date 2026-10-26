// Pourquoi l'enchère plafond n'est pas chiffrée : un motif court à afficher à la place d'un
// « À compléter » ou d'un « Aucune » sans explication.
import type { CeilingPlan } from "@/lib/bid-ceiling-engine";
import type { MarketContext } from "@/lib/market.server";

export type CeilingGap = {
  /** `incomplete` : il manque une donnée. `unprofitable` : le calcul est fait, sans enchère rentable. */
  kind: "incomplete" | "unprofitable";
  /** Motif en minuscules, sans point final. */
  reason: string;
};

/** Plafond calculé, mais inatteignable : même le premier euro dépasse le coût total maximal. */
export const UNPROFITABLE_HEADLINE = "Aucun prix ne tient";
export const UNPROFITABLE_EXPLANATION =
  "Les frais, les travaux et la libération dépassent déjà le budget que permettent la valeur du bien et vos objectifs.";

/** Motif pour lequel la valeur de marché manque, d'après la surface et l'état du calcul. */
export function valueGapReason({
  surface,
  marketStatus,
}: {
  surface: number | null | undefined;
  marketStatus?: MarketContext["status"] | null;
}): string {
  if (surface == null || !(surface > 0)) return "surface manquante";
  if (marketStatus === "queued" || marketStatus === "refreshing") return "estimation en cours";
  if (marketStatus === "insufficient_data") return "pas assez de ventes comparables";
  if (marketStatus === "failed") return "estimation indisponible";
  return "valeur de marché manquante";
}

/** `null` quand un plafond est chiffré. */
export function ceilingGap(
  plan: Pick<CeilingPlan, "available" | "reachable" | "reason">,
  valueReason: string = "valeur de marché manquante",
): CeilingGap | null {
  if (plan.available && plan.reachable) return null;
  if (plan.available) return { kind: "unprofitable", reason: "aucune enchère rentable" };
  if (plan.reason?.toLowerCase().includes("surface")) {
    return { kind: "incomplete", reason: "surface manquante" };
  }
  return { kind: "incomplete", reason: valueReason };
}
