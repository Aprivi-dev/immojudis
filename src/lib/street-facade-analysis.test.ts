import { afterEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { buildStreetFacadeAnalysis } from "@/lib/street-facade-analysis";

describe("street facade analysis", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds Mapbox street-level and 3D URLs when coordinates are available", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test-token");

    const analysis = buildStreetFacadeAnalysis(EXAMPLE_SALE);

    expect(analysis).toMatchObject({
      available: true,
      status: "coordinates_ready",
      confidence: "high",
      locationQuality: "coordinates",
      coordinates: {
        lat: EXAMPLE_SALE.latitude,
        lng: EXAMPLE_SALE.longitude,
      },
    });
    expect(analysis.streetLevelUrl).toContain("/styles/v1/mapbox/standard/static/");
    expect(analysis.aerial3dUrl).toContain("/styles/v1/mapbox/standard-satellite/static/");
    expect(analysis.mapUrl).toContain("/styles/v1/mapbox/streets-v12/static/");
  });

  it("falls back to an address search when coordinates are missing", () => {
    const analysis = buildStreetFacadeAnalysis({
      ...EXAMPLE_SALE,
      latitude: null,
      longitude: null,
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "address_only",
      confidence: "medium",
      streetLevelUrl: null,
      aerial3dUrl: null,
    });
    expect(analysis.mapUrl).toBeNull();
    expect(analysis.nextActions[0]).toContain("Géocoder");
  });

  it("keeps the feature unavailable without address or coordinates", () => {
    const analysis = buildStreetFacadeAnalysis({
      ...EXAMPLE_SALE,
      latitude: null,
      longitude: null,
      address: null,
      postal_code: null,
      city: null,
      department: null,
    });

    expect(analysis).toMatchObject({
      available: false,
      status: "missing",
      confidence: "low",
      mapUrl: null,
    });
    expect(analysis.limitations[0]).toContain("position exacte");
  });
});
