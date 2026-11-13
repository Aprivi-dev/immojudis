"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchAccessPlan } from "@/lib/client-billing";
import type { PlanEntitlements } from "@/lib/plans";
import * as queryKeys from "@/lib/query-keys";

/**
 * La seule lecture des droits du compte connecté (offre, essai gratuit et sa fin, fonctions
 * ouvertes) : une clé et des réglages communs, donc une seule requête pour toute la page. Sans
 * compte (`userId` vide), rien n'est demandé ; une panne est retentée selon la règle commune de l'app. Pour qui doit distinguer l'attente, l'échec ou relancer
 * la lecture ; les autres lisent `useAccessPlan`.
 */
export function useAccessPlanQuery(userId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.featureEntitlementsPlan(userId ?? "anonymous"),
    queryFn: fetchAccessPlan,
    enabled: Boolean(userId),
    staleTime: 5 * 60_000,
  });
}

/**
 * Les droits du compte connecté. `undefined` tant que la réponse n'est pas là, ou si elle échoue :
 * l'appelant n'annonce alors rien de propre à une offre.
 */
export function useAccessPlan(userId: string | null | undefined): PlanEntitlements | undefined {
  const { data } = useAccessPlanQuery(userId);
  return userId ? data?.plan : undefined;
}
