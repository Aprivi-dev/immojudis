import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  assertEntitlement: vi.fn(),
  weather: vi.fn(),
  assertPublicationVisible: vi.fn(),
  enforceUser: vi.fn(),
  resolveCommune: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceUserRateLimit: mocks.enforceUser,
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));

vi.mock("@/lib/climate-history.server", () => ({
  getClimateHistory: mocks.weather,
}));

vi.mock("@/lib/commune-risks.server", () => ({
  resolveSaleCommune: mocks.resolveCommune,
  validCoordinates: (latitude: unknown, longitude: unknown) =>
    typeof latitude === "number" && typeof longitude === "number",
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
  year: 2025,
  normalPeriod: { startYear: 2016, endYear: 2024 },
  stations: { temperature: null, precipitation: null, sunshine: null },
  months: [],
  summary: {},
  normal: {},
  locationSource: "listing",
  sourceUrl: "https://meteo.data.gouv.fr/",
} as const;

type SaleRow = {
  id: string;
  latitude: number | null;
  longitude: number | null;
  city?: string | null;
  postal_code?: string | null;
  department?: string | null;
};

function setup(sale: SaleRow | null) {
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

const request = () => new Request(`https://example.test/api/sales/${saleId}/weather`);
const context = { params: Promise.resolve({ id: saleId }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.assertEntitlement.mockResolvedValue({ plan: "analyse" });
  mocks.weather.mockResolvedValue(readyWeather);
  mocks.enforceUser.mockResolvedValue(1);
});

describe("sale weather route", () => {
  it("returns the Météo-France history for a visible geocoded sale", async () => {
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
    expect(query.select).toHaveBeenCalledWith("id,latitude,longitude,city,postal_code,department");
    expect(mocks.weather).toHaveBeenCalledWith(44.8378, -0.5792, { locationSource: "listing" });
    expect(mocks.resolveCommune).not.toHaveBeenCalled();
    expect(mocks.assertPublicationVisible).toHaveBeenCalledWith(saleId);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("falls back to the commune centre when the listing has no coordinates", async () => {
    setup({ id: saleId, latitude: null, longitude: null, city: "Bordeaux", postal_code: "33000" });
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

  it("returns a structured unavailable state when the sale cannot be located", async () => {
    setup({ id: saleId, latitude: null, longitude: null });
    mocks.resolveCommune.mockResolvedValue(null);

    const response = await GET(request(), context);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.weather).toEqual({ status: "unavailable", reason: "location_missing" });
    expect(mocks.weather).not.toHaveBeenCalled();
  });

  it("does not read weather for an inaccessible sale", async () => {
    setup(null);

    const response = await GET(request(), context);

    expect(response.status).toBe(404);
    expect(mocks.weather).not.toHaveBeenCalled();
    expect(mocks.assertPublicationVisible).not.toHaveBeenCalled();
  });

  it("returns 403 for Découverte before reading the sale", async () => {
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

  it("rejects malformed ids before authentication", async () => {
    const response = await GET(new Request("https://example.test/api/sales/not-a-uuid/weather"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.auth).not.toHaveBeenCalled();
  });
});
