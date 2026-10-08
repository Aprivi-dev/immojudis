import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildStreetViewEmbedUrl,
  getGoogleMapsEmbedApiKey,
  hasStreetViewCoordinates,
  hasStreetViewTarget,
  streetViewTargetLabel,
} from "./street-view";

describe("street view helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds a coordinate based Embed API URL", () => {
    const url = new URL(
      buildStreetViewEmbedUrl({ lat: 45.1234567, lng: 1.2345678 }, "  test-key  ", {
        heading: 210,
        pitch: 12,
        fov: 35,
      }),
    );

    expect(url.origin).toBe("https://www.google.com");
    expect(url.pathname).toBe("/maps/embed/v1/streetview");
    expect(url.searchParams.get("key")).toBe("test-key");
    expect(url.searchParams.get("location")).toBe("45.123457,1.234568");
    expect(url.searchParams.get("heading")).toBe("210");
    expect(url.searchParams.get("pitch")).toBe("12");
    expect(url.searchParams.get("fov")).toBe("35");
    expect(url.searchParams.get("language")).toBe("fr");
    expect(url.searchParams.get("region")).toBe("fr");
    expect(url.searchParams.get("source")).toBe("outdoor");
  });

  it("prefers a panorama id and keeps coordinates as its fallback", () => {
    const url = new URL(
      buildStreetViewEmbedUrl({ pano: " pano-123 ", lat: 48.8566, lng: 2.3522 }, "test-key"),
    );

    expect(url.searchParams.get("pano")).toBe("pano-123");
    expect(url.searchParams.get("location")).toBe("48.8566,2.3522");
  });

  it("does not pretend an address is a Street View location", () => {
    const target = { address: "10 rue de Rivoli, Paris" };

    expect(hasStreetViewTarget(target)).toBe(false);
    expect(buildStreetViewEmbedUrl(target, "test-key")).toBe("");
    expect(streetViewTargetLabel(target)).toBe("10 rue de Rivoli, Paris");
  });

  it("rejects missing keys and invalid coordinates", () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_EMBED_API_KEY", "");
    expect(getGoogleMapsEmbedApiKey()).toBe("");
    expect(buildStreetViewEmbedUrl({ lat: 46, lng: 2 })).toBe("");
    expect(hasStreetViewCoordinates({ lat: 91, lng: 2 })).toBe(false);
    expect(hasStreetViewCoordinates({ lat: 46, lng: -181 })).toBe(false);
  });

  it("clamps optional camera values to Google's documented ranges", () => {
    const url = new URL(
      buildStreetViewEmbedUrl({ lat: 46, lng: 2 }, "test-key", {
        heading: 900,
        pitch: -900,
        fov: 1,
      }),
    );

    expect(url.searchParams.get("heading")).toBe("360");
    expect(url.searchParams.get("pitch")).toBe("-90");
    expect(url.searchParams.get("fov")).toBe("10");
  });
});
