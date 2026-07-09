import type { AuctionSale } from "@/lib/types";
import { saleIsInViewport } from "./search-filters";
import type { ViewportBounds } from "./search-url-state";

export const MAX_DYNAMIC_LIST_RESULTS = 80;

export type MapViewportState = {
  bounds: ViewportBounds;
  zoom: number;
};

export type MapViewportResults = {
  sales: AuctionSale[];
  total: number;
};

export function visibleSalesForMapViewport(
  sales: AuctionSale[],
  viewport: MapViewportState | null | undefined,
  limit = MAX_DYNAMIC_LIST_RESULTS,
): MapViewportResults {
  if (!viewport) return { sales: [], total: 0 };

  const visible = sales.filter((sale) => saleIsInViewport(sale, viewport.bounds));
  return {
    sales: visible.slice(0, limit),
    total: visible.length,
  };
}

export function shouldMapListFollowViewport({
  isDesktop,
  mobileMapOpen,
  viewport,
  mapSalesCount,
}: {
  isDesktop: boolean;
  mobileMapOpen: boolean;
  viewport: MapViewportState | null | undefined;
  mapSalesCount: number;
}) {
  return Boolean((isDesktop || mobileMapOpen) && viewport && mapSalesCount > 0);
}

export function areMapViewportsClose(current: MapViewportState, next: MapViewportState) {
  if (Math.abs(current.zoom - next.zoom) > 0.02) return false;
  return (
    Math.abs(current.bounds.north - next.bounds.north) < 0.0001 &&
    Math.abs(current.bounds.south - next.bounds.south) < 0.0001 &&
    Math.abs(current.bounds.east - next.bounds.east) < 0.0001 &&
    Math.abs(current.bounds.west - next.bounds.west) < 0.0001
  );
}
