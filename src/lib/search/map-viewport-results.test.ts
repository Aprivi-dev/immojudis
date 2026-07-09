import { describe, expect, it } from "vitest";
import {
  MAX_DYNAMIC_LIST_RESULTS,
  areMapViewportsClose,
  shouldMapListFollowViewport,
  visibleSalesForMapViewport,
  type MapViewportState,
} from "./map-viewport-results";
import type { AuctionSale } from "@/lib/types";

describe("map viewport search results", () => {
  const bordeauxViewport: MapViewportState = {
    zoom: 11.5,
    bounds: {
      east: -0.1,
      north: 45.1,
      south: 44.5,
      west: -0.9,
    },
  };

  it("returns only sales visible in the current map bbox", () => {
    const visible = sale("bordeaux", 44.8378, -0.5792);
    const outside = sale("paris", 48.8566, 2.3522);
    const hidden = sale("missing-coordinates", null, null);

    expect(
      visibleSalesForMapViewport([visible, outside, hidden], bordeauxViewport).sales.map(
        (item) => item.id,
      ),
    ).toEqual(["bordeaux"]);
  });

  it("keeps a full visible count while capping the rendered list", () => {
    const sales = Array.from({ length: MAX_DYNAMIC_LIST_RESULTS + 5 }, (_, index) =>
      sale(`sale-${index}`, 44.7 + index * 0.001, -0.6),
    );

    const results = visibleSalesForMapViewport(sales, bordeauxViewport);

    expect(results.total).toBe(MAX_DYNAMIC_LIST_RESULTS + 5);
    expect(results.sales).toHaveLength(MAX_DYNAMIC_LIST_RESULTS);
  });

  it("follows the map only when a visible map surface and geocoded sales exist", () => {
    expect(
      shouldMapListFollowViewport({
        isDesktop: true,
        mobileMapOpen: false,
        viewport: bordeauxViewport,
        mapSalesCount: 1,
      }),
    ).toBe(true);
    expect(
      shouldMapListFollowViewport({
        isDesktop: false,
        mobileMapOpen: true,
        viewport: bordeauxViewport,
        mapSalesCount: 1,
      }),
    ).toBe(true);
    expect(
      shouldMapListFollowViewport({
        isDesktop: false,
        mobileMapOpen: false,
        viewport: bordeauxViewport,
        mapSalesCount: 1,
      }),
    ).toBe(false);
    expect(
      shouldMapListFollowViewport({
        isDesktop: true,
        mobileMapOpen: false,
        viewport: bordeauxViewport,
        mapSalesCount: 0,
      }),
    ).toBe(false);
  });

  it("ignores tiny viewport jitter but catches meaningful map movement or zoom", () => {
    expect(
      areMapViewportsClose(bordeauxViewport, {
        zoom: 11.51,
        bounds: {
          east: -0.10005,
          north: 45.10005,
          south: 44.50005,
          west: -0.90005,
        },
      }),
    ).toBe(true);
    expect(
      areMapViewportsClose(bordeauxViewport, {
        ...bordeauxViewport,
        zoom: 11.55,
      }),
    ).toBe(false);
    expect(
      areMapViewportsClose(bordeauxViewport, {
        zoom: 11.5,
        bounds: {
          ...bordeauxViewport.bounds,
          west: -1.2,
        },
      }),
    ).toBe(false);
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
