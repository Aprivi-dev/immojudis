import { beforeEach, describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => ({ panel: vi.fn(), mapbox: vi.fn() }));

vi.mock("./MapPanel", () => {
  loaded.panel();
  return { MapPanel: () => null };
});
vi.mock("mapbox-gl", () => {
  loaded.mapbox();
  return { default: {} };
});

import { preloadMapModules } from "./preload-map";

describe("preloadMapModules", () => {
  beforeEach(() => {
    loaded.panel.mockClear();
    loaded.mapbox.mockClear();
  });

  it("ne charge rien tant qu'on ne l'appelle pas", () => {
    expect(loaded.panel).not.toHaveBeenCalled();
    expect(loaded.mapbox).not.toHaveBeenCalled();
  });

  it("charge le module de la carte et Mapbox GL, sans rien attendre", async () => {
    expect(preloadMapModules()).toBeUndefined();
    await vi.waitFor(() => {
      expect(loaded.panel).toHaveBeenCalled();
      expect(loaded.mapbox).toHaveBeenCalled();
    });
  });
});
