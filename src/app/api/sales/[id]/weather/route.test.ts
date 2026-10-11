import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  location: vi.fn(),
  weather: vi.fn(),
  resolveCommune: vi.fn(),
  enforceIp: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sale-location.server", () => ({ loadVisibleSaleLocation: mocks.location }));
vi.mock("@/lib/rate-limit", () => ({ enforceIpRateLimit: mocks.enforceIp }));
vi.mock("@/lib/climate-history.server", () => ({ getClimateHistory: mocks.weather }));
vi.mock("@/lib/commune-risks.server", () => ({
  resolveSaleCommune: mocks.resolveCommune,
  validCoordinates: (latitude: unknown, longitude: unknown) =>
    typeof latitude === "number" && typeof longitude === "number",
}));

import { GET } from "./route";

const saleId = "11111111-1111-4111-8111-111111111111";
const request = () => new Request(`https://example.test/api/sales/${saleId}/weather`);
const context = { params: Promise.resolve({ id: saleId }) };
const readyWeather = {
  status: "ready",
  year: 2025,
  normalPeriod: { startYear: 2016, endYear: 2024 },
  stations: { temperature: null, precipitation: null, sunshine: null },
  months: [],
  summary: {},
  normal: {},
  locationSource: "listing",
  sourceUrl: "https://meteo.data.gouv.fr/",
} as const;

function sale(overrides: Record<string, unknown> = {}) {
  return {
    latitude: 44.8378,
    longitude: -0.5792,
    city: "Bordeaux",
    postalCode: "33000",
    department: "33",
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.enforceIp.mockResolvedValue(undefined);
  mocks.location.mockResolvedValue(sale());
  mocks.weather.mockResolvedValue(readyWeather);
});

describe("public sale weather route", () => {
  it("returns the Météo-France history without the listing coordinates", async () => {
    const response = await GET(request(), context);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ saleId, weather: readyWeather });
    expect(JSON.stringify(payload)).not.toContain("44.8378");
    expect(mocks.weather).toHaveBeenCalledWith(44.8378, -0.5792, { locationSource: "listing" });
    expect(mocks.resolveCommune).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("s-maxage=86400");
  });

  it("falls back to the commune centre when the listing has no coordinates", async () => {
    mocks.location.mockResolvedValue(sale({ latitude: null, longitude: null, department: null }));
    mocks.resolveCommune.mockResolvedValue({
      code: "33063",
      name: "Bordeaux",
      latitude: 44.8572,
      longitude: -0.5874,
    });

    const response = await GET(request(), context);

    expect(response.status).toBe(200);
    expect(mocks.resolveCommune).toHaveBeenCalledWith({
      latitude: null,
      longitude: null,
      city: "Bordeaux",
      postalCode: "33000",
      department: null,
    });
    expect(mocks.weather).toHaveBeenCalledWith(44.8572, -0.5874, { locationSource: "commune" });
  });

  it("reports an unlocated sale briefly cached", async () => {
    mocks.location.mockResolvedValue(sale({ latitude: null, longitude: null }));
    mocks.resolveCommune.mockResolvedValue(null);

    const response = await GET(request(), context);

    expect(await response.json()).toEqual({
      saleId,
      weather: { status: "unavailable", reason: "location_missing" },
    });
    expect(response.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=300");
    expect(mocks.weather).not.toHaveBeenCalled();
  });

  it("answers 404 for a missing or quarantined sale", async () => {
    mocks.location.mockResolvedValue(null);

    const response = await GET(request(), context);

    expect(response.status).toBe(404);
    expect(mocks.weather).not.toHaveBeenCalled();
  });

  it("rate-limits by IP before touching the database", async () => {
    mocks.enforceIp.mockRejectedValue(new RateLimitError(undefined, 12));

    const response = await GET(request(), context);

    expect(response.status).toBe(429);
    expect(mocks.location).not.toHaveBeenCalled();
  });

  it("rejects malformed ids", async () => {
    const response = await GET(new Request("https://example.test/api/sales/x/weather"), {
      params: Promise.resolve({ id: "x" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.enforceIp).not.toHaveBeenCalled();
  });
});
