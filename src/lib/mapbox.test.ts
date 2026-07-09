import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getMapboxStyleUrl,
  mapboxAerial3dUrl,
  mapboxStaticImageUrl,
  mapboxStreetLevelUrl,
  normalizeMapboxStyle,
} from "./mapbox";

describe("mapbox helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("normalizes Mapbox style inputs to owner/style paths", () => {
    expect(normalizeMapboxStyle("mapbox://styles/mapbox/streets-v12")).toBe("mapbox/streets-v12");
    expect(
      normalizeMapboxStyle("https://api.mapbox.com/styles/v1/acme/custom/tiles/256/1/2/3"),
    ).toBe("acme/custom");
  });

  it("builds static image URLs in longitude,latitude order", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test-token");
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_STYLE", "mapbox://styles/acme/custom/draft");

    const url = mapboxStaticImageUrl({
      lat: 45.1234567,
      lng: 1.2345678,
      zoom: 14,
      width: 200,
      height: 100,
    });

    expect(url).toContain(
      "/styles/v1/acme/custom/static/pin-s+0f766e(1.234568,45.123457)/1.234568,45.123457,14/200x100@2x",
    );
    expect(url).toContain("access_token=pk.test-token");
  });

  it("returns a Mapbox style URL and no static image URL without a token", () => {
    expect(getMapboxStyleUrl()).toBe("mapbox://styles/mapbox/streets-v12");
    expect(mapboxStaticImageUrl({ lat: 45, lng: 1 })).toBe("");
  });

  it("builds tilted Mapbox views for street-level and 3D aerial previews", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test-token");

    expect(mapboxStreetLevelUrl(45.1234567, 1.2345678)).toContain(
      "/styles/v1/mapbox/standard/static/pin-s+0f766e(1.234568,45.123457)/1.234568,45.123457,18,20,72/1280x720@2x",
    );
    expect(mapboxAerial3dUrl(45.1234567, 1.2345678)).toContain(
      "/styles/v1/mapbox/standard-satellite/static/pin-s+0f766e(1.234568,45.123457)/1.234568,45.123457,17.2,36,68/1280x720@2x",
    );
  });
});
