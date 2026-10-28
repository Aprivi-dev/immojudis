import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  MAPBOX_ATTRIBUTION,
  MAPBOX_SATELLITE_ATTRIBUTION,
  getMapboxStyleUrl,
  mapboxLocaleFr,
  mapboxAerial3dUrl,
  mapboxSatelliteImageUrl,
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

  it("keeps @2x by default and only drops it or adds a native format on request", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test-token");
    const base = { lat: 45, lng: 1, zoom: 14, width: 400, height: 300, marker: false };

    expect(mapboxStaticImageUrl(base)).toContain("/1,45,14/400x300@2x?access_token=");
    expect(mapboxStaticImageUrl({ ...base, pixelRatio: 1 })).toContain(
      "/1,45,14/400x300?access_token=",
    );
    expect(mapboxStaticImageUrl({ ...base, format: "webp" })).toContain(
      "/1,45,14/400x300@2x.webp?access_token=",
    );
    expect(mapboxStaticImageUrl({ ...base, pixelRatio: 1, format: "webp" })).toContain(
      "/1,45,14/400x300.webp?access_token=",
    );
    expect(
      mapboxSatelliteImageUrl({ lat: 45, lng: 1, width: 400, height: 300, pixelRatio: 1 }),
    ).toContain("/mapbox/satellite-v9/static/");
  });

  it("returns a Mapbox style URL and no static image URL without a token", () => {
    expect(getMapboxStyleUrl()).toBe("mapbox://styles/mapbox/streets-v12");
    expect(mapboxStaticImageUrl({ lat: 45, lng: 1 })).toBe("");
  });

  it("builds tilted Mapbox views for street-level and 3D aerial previews", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test-token");

    expect(mapboxStreetLevelUrl(45.1234567, 1.2345678)).toContain(
      "/styles/v1/mapbox/streets-v12/static/pin-s+0f766e(1.234568,45.123457)/1.234568,45.123457,18,20,72/1280x720@2x",
    );
    expect(mapboxAerial3dUrl(45.1234567, 1.2345678)).toContain(
      "/styles/v1/mapbox/satellite-v9/static/pin-s+0f766e(1.234568,45.123457)/1.234568,45.123457,17.2,36,68/1280x720@2x",
    );
    expect(
      mapboxSatelliteImageUrl({ lat: 45.1234567, lng: 1.2345678, width: 640, height: 360 }),
    ).toContain("/styles/v1/mapbox/satellite-v9/static/");
  });

  it("draws a white pin on satellite images and keeps the teal pin on street maps", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test-token");

    expect(mapboxSatelliteImageUrl({ lat: 45, lng: 1 })).toContain("/static/pin-s+ffffff(1,45)/");
    expect(mapboxSatelliteImageUrl({ lat: 45, lng: 1, pinColor: "132238" })).toContain(
      "/static/pin-s+132238(1,45)/",
    );
    expect(mapboxStaticImageUrl({ lat: 45, lng: 1 })).toContain("/static/pin-s+0f766e(1,45)/");
  });

  it("requests the satellite placeholder at 1x in WebP", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test-token");

    const url = mapboxSatelliteImageUrl({
      lat: 45,
      lng: 1,
      width: 1280,
      height: 720,
      pixelRatio: 1,
      format: "webp",
    });
    expect(url).toMatch(/\/1280x720\.webp\?access_token=/);
  });

  it("credits Maxar on satellite images only", () => {
    expect(MAPBOX_SATELLITE_ATTRIBUTION).toContain("© Maxar");
    expect(MAPBOX_SATELLITE_ATTRIBUTION).toContain(MAPBOX_ATTRIBUTION);
    expect(MAPBOX_ATTRIBUTION).not.toContain("Maxar");
  });

  it("gives every Mapbox UI string in French, with keys mapbox-gl knows", () => {
    const locale = mapboxLocaleFr("Plan du quartier");
    expect(locale["Map.Title"]).toBe("Plan du quartier");
    expect(locale["NavigationControl.ZoomIn"]).toBe("Zoomer");
    expect(locale["NavigationControl.ZoomOut"]).toBe("Dézoomer");
    expect(locale["NavigationControl.ResetBearing"]).toMatch(/nord/);
    expect(locale["AttributionControl.ToggleAttribution"]).toMatch(/crédits/);
    expect(locale["LogoControl.Title"]).toMatch(/Mapbox/);
    const source = readFileSync("node_modules/mapbox-gl/dist/mapbox-gl-dev.js", "utf8");
    for (const key of Object.keys(locale)) expect(source).toContain(`"${key}":`);
  });
});
