import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { buildStreetFacadeAnalysis } from "@/lib/street-facade-analysis";

describe("street facade analysis", () => {
  it("builds Street View and 3D URLs when coordinates are available", () => {
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
    expect(analysis.streetViewUrl).toContain("map_action=pano");
    expect(analysis.aerial3dUrl).toContain("@44.842748,-0.586227");
    expect(analysis.mapsUrl).toContain("maps/search");
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
      streetViewUrl: null,
      aerial3dUrl: null,
    });
    expect(analysis.mapsUrl).toContain("query=63%20Pl");
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
      mapsUrl: null,
    });
    expect(analysis.limitations[0]).toContain("position exacte");
  });
});
