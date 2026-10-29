// Badges d'une évaluation de pépite (décision du 29/10/2026). Un badge est une INFORMATION stockée avec
// l'évaluation (`auction_sale_pepites.details.badges`) : il n'entre PAS dans `evaluatePepite` ni dans `is_pepite`.
// Ce module est appelé après l'évaluation, jamais avant ; aucun module de la règle (`pepite-policy.ts`) ne l'importe.
//
// « Double sortie » : le loyer estimé du bien (carte des loyers de l'ANIL, `rent-reference.ts`, la même que les
// hypothèses de `bid-ceiling-defaults.ts`) donne un rendement brut d'au moins 8 % du coût total d'achat. Le loyer de
// l'ANIL est un loyer d'annonce, charges comprises : le rendement est brut, jamais net. Le repli départemental (ordre
// de grandeur) ne donne pas le badge. Pas de badge « remise en vente » : trop peu de données.
//
// Ce module est le seul de la chaîne de la pépite à connaître la référence de loyer : le plafond de la pépite se
// calcule SANS elle (garde de `sale-ceiling.test.ts`), et `pepite-input.ts` ne la nomme pas.
import {
  ANIL_RENT_SOURCES,
  isRentApplicable,
  type RentApplicableSale,
  type RentReference,
  type RentReferenceSource,
  type RentReliability,
} from "@/lib/rent-reference";

export const PEPITE_BADGE_DOUBLE_EXIT = "double_exit" as const;
export type PepiteBadgeKey = typeof PEPITE_BADGE_DOUBLE_EXIT;

/** Rendement brut annuel minimal (loyer estimé x 12 / coût total d'achat) du badge « double sortie ». */
export const PEPITE_DOUBLE_EXIT_MIN_GROSS_YIELD = 0.08;

export const PEPITE_BADGE_LABELS: Record<PepiteBadgeKey, string> = {
  double_exit: "Double sortie",
};

export type PepiteBadge = {
  key: PepiteBadgeKey;
  label: string;
  /** Rendement brut annuel, en % du coût total (une décimale). */
  grossYieldPct: number;
  monthlyRentEur: number;
  totalCostEur: number;
  rentSource: RentReferenceSource;
  rentReliability: RentReliability;
};

/** Le loyer de référence de la vente (carte ANIL ou repli départemental), tel que le traitement le lit. */
export type PepiteRentFacts = Pick<RentReference, "rentPerM2" | "source" | "reliability">;

/**
 * Loyer mensuel estimé d'un bien : surface habitable x loyer de référence au m², arrondi à l'euro (comme les
 * hypothèses du plafond). `null` : pas de surface, ou pas de référence.
 */
export function estimatedMonthlyRentEur(
  surfaceM2: number | null | undefined,
  rent: Pick<PepiteRentFacts, "rentPerM2"> | null | undefined,
): number | null {
  if (surfaceM2 == null || !(surfaceM2 > 0) || !rent || !(rent.rentPerM2 > 0)) return null;
  return Math.round(surfaceM2 * rent.rentPerM2);
}

/**
 * Ce qu'il faut aux badges d'un bien : son loyer mensuel estimé et sa référence. Seul un logement a un loyer de
 * référence (`isRentApplicable`) ; un terrain, un parking ou un local n'en a aucun.
 */
export function badgeRentInputs(
  sale: RentApplicableSale,
  surfaceM2: number | null | undefined,
  rent: PepiteRentFacts | null | undefined,
): { monthlyRentEur: number | null; rent: PepiteRentFacts | null } {
  const applicable = rent && isRentApplicable(sale) ? rent : null;
  return { monthlyRentEur: estimatedMonthlyRentEur(surfaceM2, applicable), rent: applicable };
}

/** Les badges d'une évaluation. Vide quand le loyer ou le coût manque, ou que la référence n'est pas celle de l'ANIL. */
export function computePepiteBadges(input: {
  monthlyRentEur: number | null;
  rent: Pick<PepiteRentFacts, "source" | "reliability"> | null;
  totalCostEur: number | null;
}): PepiteBadge[] {
  const { monthlyRentEur, rent, totalCostEur } = input;
  if (
    monthlyRentEur == null ||
    !(monthlyRentEur > 0) ||
    totalCostEur == null ||
    !(totalCostEur > 0) ||
    !rent ||
    !ANIL_RENT_SOURCES.includes(rent.source)
  ) {
    return [];
  }
  const grossYield = (monthlyRentEur * 12) / totalCostEur;
  if (grossYield < PEPITE_DOUBLE_EXIT_MIN_GROSS_YIELD) return [];
  return [
    {
      key: PEPITE_BADGE_DOUBLE_EXIT,
      label: PEPITE_BADGE_LABELS.double_exit,
      grossYieldPct: Math.round(grossYield * 1000) / 10,
      monthlyRentEur,
      totalCostEur: Math.round(totalCostEur),
      rentSource: rent.source,
      rentReliability: rent.reliability,
    },
  ];
}
