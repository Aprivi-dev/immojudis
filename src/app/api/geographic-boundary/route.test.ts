import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ boundary: vi.fn(), enforceIp: vi.fn() }));

vi.mock("@/lib/rate-limit", () => ({ enforceIpRateLimit: mocks.enforceIp }));
vi.mock("@/lib/geographic-boundary", () => ({
  fetchGeographicBoundary: mocks.boundary,
  GeographicBoundaryUpstreamError: class GeographicBoundaryUpstreamError extends Error {},
}));

import { GeographicBoundaryUpstreamError } from "@/lib/geographic-boundary";
import { GET } from "./route";

const request = (query: string) =>
  new Request(`https://example.test/api/geographic-boundary?${query}`);

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  mocks.enforceIp.mockResolvedValue(undefined);
});

describe("GET /api/geographic-boundary", () => {
  it("rend le contour avec un cache public", async () => {
    mocks.boundary.mockResolvedValue(null);

    const response = await GET(request("label=Bordeaux"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      boundary: null,
      requestedLabel: "Bordeaux",
      source: "geo.api.gouv.fr",
    });
    expect(response.headers.get("cache-control")).toContain("public, max-age=3600");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it.each(["", "label=", `label=${"a".repeat(121)}`])(
    "refuse un libellé absent ou trop long (%s) en 400, sans appeler le service",
    async (query) => {
      const response = await GET(request(query));

      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      await expect(response.json()).resolves.toMatchObject({
        boundary: null,
        ok: false,
        error: "Libellé géographique invalide.",
        code: "INVALID_REQUEST",
      });
      expect(mocks.boundary).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "une panne du service de l'État",
      new GeographicBoundaryUpstreamError("Réponse GeoJSON invalide."),
    ],
    ["une panne inattendue", new Error("boom")],
  ])("répond 503 au message générique pour %s, sans cache", async (_, error) => {
    mocks.boundary.mockRejectedValue(error);

    const response = await GET(request("label=Bordeaux"));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      boundary: null,
      ok: false,
      error: "Contour géographique temporairement indisponible.",
    });
  });
});
