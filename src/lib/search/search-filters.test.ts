import { describe, expect, it } from "vitest";
import {
  applyClientSearchFilters,
  dataFiltersFromSearch,
  hasClientOnlyFilters,
  saleIsInViewport,
} from "./search-filters";
import type { ViewportBounds } from "./search-url-state";
import type { AuctionSale } from "@/lib/types";

describe("sales search filters", () => {
  it("passes viewport bounds to server-side filters", () => {
    const viewport: ViewportBounds = {
      east: 1.28,
      north: 45.43,
      south: 43.96,
      west: -1.75,
    };

    expect(dataFiltersFromSearch({ viewport })).toMatchObject({ viewport });
    expect(hasClientOnlyFilters({ viewport })).toBe(false);
  });

  it("filters visible sales when the map viewport changes", () => {
    const bordeauxViewport: ViewportBounds = {
      east: -0.1,
      north: 45.1,
      south: 44.5,
      west: -0.9,
    };
    const bordeauxSale = sale("bordeaux", 44.8378, -0.5792);
    const parisSale = sale("paris", 48.8566, 2.3522);
    const hiddenSale = sale("hidden", null, null);

    expect(saleIsInViewport(bordeauxSale, bordeauxViewport)).toBe(true);
    expect(saleIsInViewport(parisSale, bordeauxViewport)).toBe(false);
    expect(
      applyClientSearchFilters(
        [bordeauxSale, parisSale, hiddenSale],
        { viewport: bordeauxViewport },
        null,
      ).map((item) => item.id),
    ).toEqual(["bordeaux"]);
  });
});

function sale(id: string, latitude: number | null, longitude: number | null): AuctionSale {
  return {
    id,
    title: id,
    latitude,
    longitude,
    source_blocks: null,
    documents_rich: null,
  } as AuctionSale;
}
