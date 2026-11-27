"use client";

import { useQuery } from "@tanstack/react-query";
import type { AuctionScenariosResponse } from "@/lib/auction-scenarios";
import { fetchAuctionScenarios } from "@/lib/client-api";
import * as queryKeys from "@/lib/query-keys";
import type { SaleAccessMode } from "@/lib/query-keys";

/** Prix habituellement atteints par les ventes comparables, appliqués à la mise à prix de la vente. */
export type UsualAuctionRange = {
  /** Premier et troisième quartiles : la moitié centrale des ventes comparables. */
  low: number;
  high: number;
  median: number | null;
  /** Ventes du tribunal lui-même, ou repli sur les tribunaux couverts. */
  scope: "court" | "national";
  courtName: string | null;
};

/** Module pur : la fourchette en euros, ou `null` tant que les chiffres manquent. */
export function usualAuctionRange(
  data: AuctionScenariosResponse | undefined,
): UsualAuctionRange | null {
  const figures = data?.scenarios;
  const startingPrice = data?.startingPrice;
  if (!data || !figures || figures.status !== "ok" || !startingPrice) return null;
  const { q25, q50, q75 } = figures.ratioQuartiles;
  if (q25 == null || q75 == null || !(q75 >= q25)) return null;
  return {
    low: q25 * startingPrice,
    high: q75 * startingPrice,
    median: q50 != null ? q50 * startingPrice : null,
    scope: figures.priceScope,
    courtName: data.courtName,
  };
}

/**
 * La fourchette des prix habituellement atteints, pour la réglette de prix. Même lecture, mêmes
 * droits et même cache que « Scénarios d'enchères » et « Mon plafond face au tribunal » : une seule
 * requête. `enabled` faux (pas de compte, pas de statistiques) : aucune requête, `null`.
 */
export function useUsualAuctionRange({
  saleId,
  access,
  userKey,
  enabled,
}: {
  saleId: string;
  access: SaleAccessMode;
  userKey: string | undefined;
  enabled: boolean;
}): UsualAuctionRange | null {
  const query = useQuery<AuctionScenariosResponse>({
    queryKey: queryKeys.auctionScenarios(saleId, access, userKey),
    queryFn: () => fetchAuctionScenarios(saleId),
    staleTime: 30 * 60_000,
    retry: false,
    enabled,
  });
  return enabled ? usualAuctionRange(query.data) : null;
}
