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

/** Ce qui empêche le plafond d'une vente débloquée d'être chiffré, dit avant et après le déblocage. */
export type UnlockCeilingGap = {
  /** Motif en minuscules, sans point final (« surface absente »). */
  reason: string;
  /** Le motif est la surface : l'utilisateur peut saisir celle qu'il a lue dans les pièces. */
  surface: boolean;
};

export const UNLOCK_GAP_SURFACE = "surface absente";
export const UNLOCK_GAP_CONFLICT = "données de l’annonce contradictoires";
export const UNLOCK_GAP_REVIEW = "données de l’annonce en cours de vérification";

/**
 * Le plafond restera (ou est resté) à compléter : conflit de valorisation, champ critique bloqué
 * par la relecture IA, surface absente (`assessSaleCeilingInputs`, après la surface saisie par
 * l'utilisateur), puis, une fois les données de la vente lues, le motif du plan (`ceilingGap`)
 * quand il manque une donnée. `null` : rien de connu n'empêche le calcul. Une estimation en cours
 * (`pending`) n'est pas un manque : elle n'empêche rien.
 *
 * Information seulement : la règle de décompte des déblocages ne dépend pas de ce résultat.
 */
export function unlockCeilingGap({
  inputs,
  gap = null,
  pending = false,
}: {
  inputs: {
    valuationConflict: string | null;
    blocked: { critical: boolean };
    surface: number | null;
  };
  gap?: CeilingGap | null;
  pending?: boolean;
}): UnlockCeilingGap | null {
  if (inputs.valuationConflict) return { reason: UNLOCK_GAP_CONFLICT, surface: false };
  if (inputs.blocked.critical) return { reason: UNLOCK_GAP_REVIEW, surface: false };
  if (inputs.surface == null || !(inputs.surface > 0)) {
    return { reason: UNLOCK_GAP_SURFACE, surface: true };
  }
  if (pending || gap?.kind !== "incomplete" || gap.reason === "estimation en cours") return null;
  return gap.reason === "surface manquante"
    ? { reason: UNLOCK_GAP_SURFACE, surface: true }
    : { reason: gap.reason, surface: false };
}
