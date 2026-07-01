import { describe, expect, it } from "vitest";
import { getDisplaySurface, getSaleSurface, STUDIO_ESTIMATED_SURFACE_M2 } from "./surface";

describe("getSaleSurface", () => {
  it("prefers app surface over habitable and carrez surfaces", () => {
    const surface = getSaleSurface({
      app_surface_m2: 42,
      habitable_surface_m2: 45,
      carrez_surface_m2: 40,
    });

    expect(surface.value).toBe(42);
    expect(surface.estimated).toBe(false);
    expect(surface.kind).toBe("recorded");
  });

  it("estimates a missing studio surface conservatively", () => {
    const surface = getSaleSurface({ title: "Studio vendu occupé" });

    expect(surface.value).toBe(STUDIO_ESTIMATED_SURFACE_M2);
    expect(surface.estimated).toBe(true);
    expect(surface.kind).toBe("estimated");
  });
});

describe("getDisplaySurface", () => {
  it("falls back to land surface for display only", () => {
    const surface = getDisplaySurface({ property_type: "terrain", land_surface_m2: 720 });

    expect(surface.value).toBe(720);
    expect(surface.metricLabel).toBe("Terrain");
    expect(surface.kind).toBe("land");
  });
});
