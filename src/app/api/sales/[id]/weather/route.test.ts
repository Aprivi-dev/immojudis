import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  assertEntitlement: vi.fn(),
  weather: vi.fn(),
  assertPublicationVisible: vi.fn(),
  enforceUser: vi.fn(),
  tryConsume: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceUserRateLimit: mocks.enforceUser,
  tryConsumeUserRateLimit: mocks.tryConsume,
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));

vi.mock("@/lib/meteostat", () => ({
  getMeteostatHistoricalWeather: mocks.weather,
}));

vi.mock("@/lib/property-reports", () => ({
  assertFeatureEntitlement: mocks.assertEntitlement,
}));

vi.mock("@/lib/sale-publication-guard", () => ({
  assertSalePublicationVisible: mocks.assertPublicationVisible,
}));

import { GET } from "./route";

const saleId = "11111111-1111-4111-8111-111111111111";
const readyWeather = {
  status: "ready",
  source: "Meteostat",
  sourceUrl: "https://dev.meteostat.net/api/point/monthly.html",
  year: 2025,
  grid: { latitude: 44.84, longitude: -0.58 },
  months: [],
  coverage: { observedMonths: 0, expectedMonths: 12 },
  unsupportedMetrics: ["humidity", "uvIndex"],
  fetchedAt: "2026-10-06T10:00:00.000Z",
  stale: false,
} as const;

function setup(sale: { id: string; latitude: number | null; longitude: number | null } | null) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({ data: sale, error: null });
  const from = vi.fn().mockReturnValue(query);
  const auth = { supabase: { from } };
  mocks.auth.mockResolvedValue(auth);
  return { query, from, auth };
}

function setupQuery() {
  const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({
    data: { id: saleId, latitude: 44.8378, longitude: -0.5792 },
    error: null,
  });
  return query;
}

const request = () => new Request(`https://example.test/api/sales/${saleId}/weather`);
const context = { params: Promise.resolve({ id: saleId }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.assertEntitlement.mockResolvedValue({ plan: "analyse" });
  mocks.weather.mockResolvedValue(readyWeather);
  mocks.enforceUser.mockResolvedValue(1);
  mocks.tryConsume.mockResolvedValue(true);
});

describe("sale weather route", () => {
  it("returns the provider result for a visible geocoded sale", async () => {
    const { query, auth } = setup({ id: saleId, latitude: 44.8378, longitude: -0.5792 });

    const response = await GET(request(), context);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ saleId, weather: readyWeather });
    expect(mocks.assertEntitlement).toHaveBeenCalledWith(
      auth,
      "property.weatherHistory",
      "Historique météo réservé au plan Analyse.",
    );
    expect(query.select).toHaveBeenCalledWith("id,latitude,longitude");
    expect(mocks.weather).toHaveBeenCalledWith(44.8378, -0.5792, {
      beforeUpstreamFetch: expect.any(Function),
    });
    expect(mocks.assertPublicationVisible).toHaveBeenCalledWith(saleId);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns a structured unavailable state when coordinates are missing", async () => {
    setup({ id: saleId, latitude: null, longitude: null });

    const response = await GET(request(), context);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.weather).toMatchObject({
      status: "unavailable",
      reason: "coordinates_missing",
    });
    expect(mocks.weather).not.toHaveBeenCalled();
  });

  it("does not read weather for an inaccessible sale", async () => {
    setup(null);

    const response = await GET(request(), context);

    expect(response.status).toBe(404);
    expect(mocks.weather).not.toHaveBeenCalled();
    expect(mocks.assertPublicationVisible).not.toHaveBeenCalled();
  });

  it("returns 403 for Découverte before the sale or Meteostat quota path", async () => {
    const { from, auth } = setup({ id: saleId, latitude: 44.8378, longitude: -0.5792 });
    mocks.assertEntitlement.mockRejectedValue(
      new Error("Historique météo réservé au plan Analyse."),
    );

    const response = await GET(request(), context);

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("authorization");
    expect(mocks.assertEntitlement).toHaveBeenCalledWith(
      auth,
      "property.weatherHistory",
      "Historique météo réservé au plan Analyse.",
    );
    expect(from).not.toHaveBeenCalled();
    expect(mocks.weather).not.toHaveBeenCalled();
  });

  it("returns 401 privately for an anonymous request before any feature or weather access", async () => {
    mocks.auth.mockRejectedValue(new Error("Unauthorized: session required"));

    const response = await GET(request(), context);

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("authorization");
    expect(mocks.assertEntitlement).not.toHaveBeenCalled();
    expect(mocks.weather).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After once the per-minute budget is spent", async () => {
    setup({ id: saleId, latitude: 44.8378, longitude: -0.5792 });
    mocks.enforceUser.mockRejectedValue(new RateLimitError(undefined, 37));

    const response = await GET(request(), context);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
    expect(mocks.weather).not.toHaveBeenCalled();
  });

  it("charges only upstream cache misses to the 5-per-day Meteostat budget", async () => {
    setup({ id: saleId, latitude: 44.8378, longitude: -0.5792 });
    mocks.auth.mockResolvedValue({
      userId: "user-1",
      supabase: { from: vi.fn().mockReturnValue(setupQuery()) },
    });
    await GET(request(), context);

    expect(mocks.tryConsume).not.toHaveBeenCalled();
    const options = mocks.weather.mock.calls[0]?.[2] as {
      beforeUpstreamFetch: () => Promise<boolean>;
    };
    await options.beforeUpstreamFetch();
    expect(mocks.tryConsume).toHaveBeenCalledWith({
      userId: "user-1",
      bucketKey: "sales.weather.upstream",
      limit: 5,
      windowSeconds: 86_400,
    });
  });

  it("rejects malformed ids before authentication", async () => {
    const response = await GET(new Request("https://example.test/api/sales/not-a-uuid/weather"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.auth).not.toHaveBeenCalled();
  });
});
