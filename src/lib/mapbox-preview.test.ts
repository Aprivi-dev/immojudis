import { describe, expect, it } from "vitest";
import {
  mapboxPreviewCamera,
  mapboxPreviewLoadingLabel,
  mapboxPreviewModeLabel,
} from "@/lib/mapbox-preview";

describe("mapbox preview modes", () => {
  it("uses Mapbox Standard Satellite with terrain for the 3D aerial view", () => {
    expect(mapboxPreviewCamera("aerial3d")).toMatchObject({
      style: "mapbox://styles/mapbox/standard-satellite",
      pitch: 68,
      terrain: true,
    });
  });

  it("uses Mapbox Standard as a street-level map view", () => {
    expect(mapboxPreviewCamera("streetLevel")).toMatchObject({
      style: "mapbox://styles/mapbox/standard",
      pitch: 72,
      terrain: false,
    });
  });

  it("labels the map modes without implying photographic street imagery", () => {
    expect(mapboxPreviewModeLabel("aerial3d")).toBe("Vue aérienne 3D Mapbox");
    expect(mapboxPreviewModeLabel("streetLevel")).toBe("Vue 3D du quartier");
    expect(mapboxPreviewLoadingLabel("streetLevel")).toBe("Chargement de la vue 3D du quartier...");
  });
});
