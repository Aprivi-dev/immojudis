"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchAccessPlan } from "@/lib/client-billing";
import type { PlanEntitlements } from "@/lib/property-reports";
import * as queryKeys from "@/lib/query-keys";

/**
 * Les droits du compte connecté (offre, essai gratuit et sa fin). `undefined` tant que la réponse
 * n'est pas là, ou si elle échoue : l'appelant n'annonce alors rien de propre à l'essai. Même clé
 * que `useHasAnalysisAccess`, donc une seule requête pour les deux.
 */
export function useAccessPlan(userId: string | null | undefined): PlanEntitlements | undefined {
  const { data } = useQuery({
    queryKey: queryKeys.featureEntitlementsPlan(userId ?? "anonymous"),
    queryFn: fetchAccessPlan,
    enabled: Boolean(userId),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return userId ? data?.plan : undefined;
}
