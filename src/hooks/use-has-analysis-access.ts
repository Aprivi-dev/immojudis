"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchAccessPlan } from "@/lib/client-billing";
import * as queryKeys from "@/lib/query-keys";

/**
 * Le compte ouvre-t-il toutes les ventes (offre Analyse, y compris une offre de lancement) ?
 * `undefined` tant que la réponse n'est pas là, ou si elle échoue : l'appelant n'affiche alors
 * rien de propre à l'une ou l'autre offre. Même clé que les autres pages, donc une seule requête.
 */
export function useHasAnalysisAccess(userId: string | null | undefined): boolean | undefined {
  const { data } = useQuery({
    queryKey: queryKeys.featureEntitlementsPlan(userId ?? "anonymous"),
    queryFn: fetchAccessPlan,
    enabled: Boolean(userId),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return userId ? data?.plan.hasAnalysisAccess : undefined;
}
