import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({ find: vi.fn(), enforceIp: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rate-limit", () => ({ enforceIpRateLimit: mocks.enforceIp }));
vi.mock("@/lib/street-view-panorama.server", () => ({ findStreetViewPanorama: mocks.find }));

import { GET } from "./route";

const request = (query: string) => new Request(`https://example.test/api/street-view?${query}`);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.enforceIp.mockResolvedValue(undefined);
});

describe("street view panorama route", () => {
  it("returns the panorama with a long edge cache", async () => {
    const panorama = { status: "ready", pano: "p", heading: 90, distanceM: 12, date: null };
    mocks.find.mockResolvedValue(panorama);

    const response = await GET(request("lat=44.8378&lng=-0.5792"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ panorama });
    expect(mocks.find).toHaveBeenCalledWith(44.8378, -0.5792);
    expect(response.headers.get("cache-control")).toContain("s-maxage=604800");
  });

  it("does not cache a missing configuration", async () => {
    mocks.find.mockResolvedValue({ status: "unavailable", reason: "not_configured" });

    const response = await GET(request("lat=44.8&lng=-0.5"));

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each(["", "lat=91&lng=2", "lat=x&lng=2", "lat=45"])(
    "rejects invalid coordinates (%s)",
    async (query) => {
      const response = await GET(request(query));

      expect(response.status).toBe(400);
      expect(mocks.enforceIp).not.toHaveBeenCalled();
    },
  );

  it("rate-limits by IP before calling Google", async () => {
    mocks.enforceIp.mockRejectedValue(new RateLimitError(undefined, 12));

    const response = await GET(request("lat=44.8&lng=-0.5"));

    expect(response.status).toBe(429);
    expect(mocks.find).not.toHaveBeenCalled();
  });

  it("answers an error instead of crashing when Google fails", async () => {
    mocks.find.mockRejectedValue(new Error("REQUEST_DENIED"));

    const response = await GET(request("lat=44.8&lng=-0.5"));

    expect(response.status).toBeGreaterThanOrEqual(500);
  });
});
