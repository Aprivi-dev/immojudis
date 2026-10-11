import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  bearingDegrees,
  distanceMeters,
  findStreetViewPanorama,
  isGoogleImagery,
} from "./street-view-panorama.server";

const property = { lat: 44.8378, lng: -0.5792 };

function metadata(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => body };
}

function google(pano: string, lat: number, lng: number) {
  return metadata({
    status: "OK",
    copyright: "© Google",
    pano_id: pano,
    date: "2024-05",
    location: { lat, lng },
  });
}

const contributed = metadata({
  status: "OK",
  copyright: "© Helena Vila",
  pano_id: "CAoSF0NJSE0wb2dLRUlDQWdJRGtqWXpLcWdF",
  location: { lat: 44.83779, lng: -0.57918 },
});

afterEach(() => vi.unstubAllGlobals());

describe("findStreetViewPanorama", () => {
  it("keeps the Google panorama found at the listing and faces the property", async () => {
    const fetchMock = vi.fn().mockResolvedValue(google("car-1", 44.8377, -0.5792));
    vi.stubGlobal("fetch", fetchMock);

    const result = await findStreetViewPanorama(property.lat, property.lng, "key");

    expect(result).toEqual({
      status: "ready",
      pano: "car-1",
      heading: 0,
      distanceM: 11,
      date: "2024-05",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("source")).toBe("outdoor");
    expect(url.searchParams.get("radius")).toBe("50");
  });

  it("skips contributed photo spheres and keeps the closest Google panorama around", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(contributed)
      .mockResolvedValueOnce(google("far", 44.8384, -0.5792))
      .mockResolvedValueOnce(contributed)
      .mockResolvedValueOnce(google("near", 44.8378, -0.5789))
      .mockResolvedValue(metadata({ status: "ZERO_RESULTS" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await findStreetViewPanorama(property.lat, property.lng, "key");

    expect(fetchMock).toHaveBeenCalledTimes(9);
    expect(result).toMatchObject({ status: "ready", pano: "near", distanceM: 24, heading: 270 });
  });

  it("reports missing Google imagery instead of a far or contributed panorama", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(contributed)
      .mockResolvedValueOnce(google("too-far", 44.8392, -0.5792))
      .mockResolvedValue(metadata({ status: "ZERO_RESULTS" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(findStreetViewPanorama(property.lat, property.lng, "key")).resolves.toEqual({
      status: "unavailable",
      reason: "no_google_imagery",
    });
  });

  it("does not call Google without a key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(findStreetViewPanorama(property.lat, property.lng, "")).resolves.toEqual({
      status: "unavailable",
      reason: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a rejected key as an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(metadata({ status: "REQUEST_DENIED", error_message: "denied" })),
    );

    await expect(findStreetViewPanorama(property.lat, property.lng, "key")).rejects.toThrow(
      "REQUEST_DENIED",
    );
  });
});

describe("geometry helpers", () => {
  it("measures distances and bearings", () => {
    expect(Math.round(distanceMeters(44.8378, -0.5792, 44.8387, -0.5792))).toBe(100);
    expect(Math.round(bearingDegrees(44.8378, -0.5792, 44.8387, -0.5792))).toBe(0);
    expect(Math.round(bearingDegrees(44.8378, -0.5792, 44.8378, -0.578))).toBe(90);
  });

  it("recognises Google car imagery", () => {
    expect(isGoogleImagery("© Google", "7bluG8bQzJYeOtNkoy9nRw")).toBe(true);
    expect(isGoogleImagery("© 2026 Google", "7bluG8bQzJYeOtNkoy9nRw")).toBe(true);
    expect(isGoogleImagery("© drone Aquitaine", "abc")).toBe(false);
    expect(isGoogleImagery("© Google", "CAoSF0NJSE0wb2dLRUlDQWdJRGtqWXpLcWdF")).toBe(false);
    expect(isGoogleImagery(undefined, "abc")).toBe(false);
  });
});
