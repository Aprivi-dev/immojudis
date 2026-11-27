"use client";

import type { ComponentProps } from "react";
import { PriceScale } from "@/components/sale-detail/PriceScale";
import { useUsualAuctionRange } from "@/components/sale-detail/use-usual-auction-range";

/**
 * La réglette de prix avec, quand le compte y a droit, les prix habituellement atteints par les
 * ventes comparables (`useUsualAuctionRange` : même lecture que « Scénarios d'enchères »).
 */
export function CourtPriceScale({
  saleId,
  access,
  userKey,
  courtEnabled,
  ...scale
}: Omit<ComponentProps<typeof PriceScale>, "usual"> &
  Omit<Parameters<typeof useUsualAuctionRange>[0], "enabled"> & {
    /** Statistiques du tribunal ouvertes, compte connecté, hors annonce exemple. */
    courtEnabled: boolean;
  }) {
  const usual = useUsualAuctionRange({ saleId, access, userKey, enabled: courtEnabled });
  return <PriceScale {...scale} usual={usual} />;
}
