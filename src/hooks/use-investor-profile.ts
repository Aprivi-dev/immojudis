"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchInvestorProfile } from "@/lib/client-api";
import type { InvestorProfile } from "@/lib/investor-profile";
import * as queryKeys from "@/lib/query-keys";

/**
 * Le profil d'investisseur du compte (n° 93), `null` sans profil ou sans compte. Une panne de lecture
 * n'empêche jamais le calcul du plafond : sans profil, il retombe sur ses hypothèses de départ.
 */
export function useInvestorProfile(userId: string | null | undefined): {
  profile: InvestorProfile | null;
  loading: boolean;
} {
  const query = useQuery({
    queryKey: queryKeys.investorProfile(userId ?? null),
    queryFn: () => fetchInvestorProfile(),
    enabled: Boolean(userId),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return { profile: query.data?.profile ?? null, loading: Boolean(userId) && query.isPending };
}
