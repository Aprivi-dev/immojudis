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
  uncertaintyCircle,
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

  it("draws an uncertainty disc under the pin and can ask for street names on satellite imagery", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test-token");

    const url = mapboxSatelliteImageUrl({
      lat: 45,
      lng: 1,
      streets: true,
      uncertaintyMeters: 30,
      pixelRatio: 1,
    });
    expect(url).toContain("/styles/v1/mapbox/satellite-streets-v12/static/geojson(");
    expect(url).toMatch(/%7D\),pin-s\+0f766e\(1,45\)\/1,45,17\/640x360\?/);
    // Sans rayon, l'URL est celle d'avant : repère seul.
    expect(mapboxSatelliteImageUrl({ lat: 45, lng: 1, pixelRatio: 1 })).toContain(
      "/mapbox/satellite-v9/static/pin-s+0f766e(1,45)/1,45,17/640x360?",
    );
    // L'URL reste bien en dessous de la limite de l'API (8 192 caractères).
    expect(url.length).toBeLessThan(1500);
  });

  it("builds a closed 24-sided disc whose radius is in metres", () => {
    const { type, coordinates } = uncertaintyCircle(45, 1, 100);
    const ring = coordinates[0];

    expect(type).toBe("Polygon");
    expect(ring).toHaveLength(25);
    expect(ring[24]).toEqual(ring[0]);
    const latitudeSpan = Math.max(...ring.map(([, lat]) => lat)) - 45;
    const longitudeSpan = Math.max(...ring.map(([lng]) => lng)) - 1;
    expect(latitudeSpan).toBeCloseTo(100 / 111_320, 5);
    // À 45 degrés de latitude, un degré de longitude vaut cos(45°) fois un degré de latitude.
    expect(longitudeSpan).toBeCloseTo(100 / (111_320 * Math.cos(Math.PI / 4)), 5);
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
