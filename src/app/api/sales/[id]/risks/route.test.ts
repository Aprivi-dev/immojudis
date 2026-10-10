import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  maybeSingle: vi.fn(),
  select: vi.fn(),
  resolve: vi.fn(),
  profile: vi.fn(),
  enforceIp: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/public-sale.server", () => ({ lookupPublicSale: mocks.lookup }));
vi.mock("@/lib/rate-limit", () => ({ enforceIpRateLimit: mocks.enforceIp }));
vi.mock("@/lib/commune-risks.server", () => ({
  resolveSaleCommune: mocks.resolve,
  getCommuneRiskProfile: mocks.profile,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const query = { select: mocks.select, eq: () => query, maybeSingle: mocks.maybeSingle };
      mocks.select.mockReturnValue(query);
      return query;
    },
  },
}));

import { GET } from "./route";

const saleId = "11111111-1111-4111-8111-111111111111";
const request = () => new Request(`https://example.test/api/sales/${saleId}/risks`);
const context = { params: Promise.resolve({ id: saleId }) };
const location = {
  latitude: 44.84,
  longitude: -0.58,
  city: "Bordeaux",
  postal_code: "33000",
  department: "33",
};
const profile = { status: "ready", commune: { code: "33063", name: "Bordeaux" } };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.enforceIp.mockResolvedValue(undefined);
  mocks.lookup.mockResolvedValue({ status: "found", sale: { id: saleId } });
  mocks.maybeSingle.mockResolvedValue({ data: location, error: null });
  mocks.resolve.mockResolvedValue({ code: "33063", name: "Bordeaux", latitude: 0, longitude: 0 });
  mocks.profile.mockResolvedValue(profile);
});

describe("public sale risks route", () => {
  it("returns the commune profile without the listing coordinates", async () => {
    const response = await GET(request(), context);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ saleId, risks: profile });
    expect(JSON.stringify(payload)).not.toContain("44.84");
    expect(mocks.resolve).toHaveBeenCalledWith({
      latitude: 44.84,
      longitude: -0.58,
      city: "Bordeaux",
      postalCode: "33000",
      department: "33",
    });
    expect(response.headers.get("cache-control")).toContain("s-maxage=86400");
  });

  it("answers 404 for a sale outside the public catalogue", async () => {
    mocks.lookup.mockResolvedValue({ status: "missing" });

    const response = await GET(request(), context);

    expect(response.status).toBe(404);
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
  });

  it("reports an unresolved commune briefly cached", async () => {
    mocks.resolve.mockResolvedValue(null);

    const response = await GET(request(), context);

    expect(await response.json()).toEqual({
      saleId,
      risks: { status: "unavailable", reason: "commune_not_found" },
    });
    expect(response.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=300");
    expect(mocks.profile).not.toHaveBeenCalled();
  });

  it("rate-limits by IP before touching the database", async () => {
    mocks.enforceIp.mockRejectedValue(new RateLimitError(undefined, 12));

    const response = await GET(request(), context);

    expect(response.status).toBe(429);
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("rejects malformed ids", async () => {
    const response = await GET(new Request("https://example.test/api/sales/x/risks"), {
      params: Promise.resolve({ id: "x" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.enforceIp).not.toHaveBeenCalled();
  });
});
