import { afterEach, describe, expect, it, vi } from "vitest";
import { mapboxStaticImageUrl } from "./mapbox";
import { uncertaintyCircle, uncertaintyOverlay } from "./mapbox-accuracy";

describe("uncertaintyCircle", () => {
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
});

describe("static image overlay", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("draws the disc under the pin, keeps the URL short and leaves other images untouched", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test-token");
    const overlay = uncertaintyOverlay(45, 1, 30);

    const url = mapboxStaticImageUrl({
      lat: 45,
      lng: 1,
      overlay,
      style: "mapbox/satellite-streets-v12",
      pixelRatio: 1,
    });

    expect(overlay).toMatch(/^geojson\(%7B.*%7D\)$/);
    expect(url).toContain("/styles/v1/mapbox/satellite-streets-v12/static/geojson(");
    expect(url).toMatch(/%7D\),pin-s\+0f766e\(1,45\)\/1,45,15\/640x360\?/);
    // L'API refuse une URL de plus de 8 192 caractères.
    expect(url.length).toBeLessThan(1500);
    expect(mapboxStaticImageUrl({ lat: 45, lng: 1, pixelRatio: 1 })).toContain(
      "/static/pin-s+0f766e(1,45)/1,45,15/640x360?",
    );
    expect(
      mapboxStaticImageUrl({ lat: 45, lng: 1, marker: false, overlay, pixelRatio: 1 }),
    ).toMatch(/\/static\/geojson\(.*%7D\)\/1,45,15\//);
    expect(mapboxStaticImageUrl({ lat: 45, lng: 1, marker: false, pixelRatio: 1 })).toContain(
      "/static/1,45,15/640x360?",
    );
  });
});
