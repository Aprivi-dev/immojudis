"use client";

import { useAccessPlan } from "@/hooks/use-access-plan";

/**
 * Le compte ouvre-t-il toutes les ventes (offre Analyse, y compris une offre de lancement) ?
 * `undefined` tant que la réponse n'est pas là, ou si elle échoue : l'appelant n'affiche alors
 * rien de propre à l'une ou l'autre offre.
 */
export function useHasAnalysisAccess(userId: string | null | undefined): boolean | undefined {
  return useAccessPlan(userId)?.hasAnalysisAccess;
}
