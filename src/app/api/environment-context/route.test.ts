import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  entitlement: vi.fn(),
  saleForDoor: vi.fn(),
  environment: vi.fn(),
  daily: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/rate-limit", () => ({
  enforceUserRateLimit: vi.fn(async () => 1),
  enforceDailyOperationLimits: mocks.daily,
}));
vi.mock("@/lib/entitlements.server", () => ({
  assertFeatureEntitlementVia: mocks.entitlement,
  getSaleForDoor: mocks.saleForDoor,
}));
vi.mock("@/lib/environmental-context", () => ({
  getEnvironmentalContext: mocks.environment,
  environmentalContextCacheControl: () => "private, no-store",
}));

import { POST } from "./route";

const saleId = "11111111-1111-4111-8111-111111111111";
const auth = { userId: "user-1" };
const freeAddress = { address: "1 avenue des Champs-Élysées, Paris", lat: 48.87, lng: 2.31 };
const sale = {
  id: saleId,
  address: "3 rue de la Paix",
  postal_code: "69001",
  city: "Lyon",
  latitude: 45.76,
  longitude: 4.83,
};

const call = (body: Record<string, unknown>) =>
  POST(
    new Request("https://example.test/api/environment-context", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

describe("POST /api/environment-context", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.auth.mockResolvedValue(auth);
    mocks.daily.mockResolvedValue(undefined);
    mocks.environment.mockResolvedValue({ ok: true, error: null, context: null });
    mocks.saleForDoor.mockResolvedValue({ sale, enrichmentKey: "https://source.example/1" });
  });

  it("keeps the free query of an address for the offer, as before", async () => {
    mocks.entitlement.mockResolvedValue({ plan: { plan: "analyse" }, door: "plan" });

    expect((await call(freeAddress)).status).toBe(200);

    expect(mocks.entitlement).toHaveBeenCalledWith(
      auth,
      "property.neighborhoodAnalysis",
      expect.any(String),
      { saleId: undefined },
    );
    expect(mocks.environment).toHaveBeenCalledWith(freeAddress);
    expect(mocks.saleForDoor).not.toHaveBeenCalled();
  });

  it("refuses a free account that sends an address without a sale", async () => {
    mocks.entitlement.mockRejectedValue(
      new ForbiddenError("Contexte environnemental réservé à l’offre Analyse."),
    );

    expect((await call(freeAddress)).status).toBe(403);
    expect(mocks.environment).not.toHaveBeenCalled();
    expect(mocks.daily).not.toHaveBeenCalled();
  });

  it("uses the unlocked sale's own place, read on the server, never an address sent by the account", async () => {
    mocks.entitlement.mockResolvedValue({ plan: { plan: "decouverte" }, door: "unlock" });

    const response = await call({ saleId, ...freeAddress });

    expect(response.status).toBe(200);
    expect(mocks.entitlement).toHaveBeenCalledWith(
      auth,
      "property.neighborhoodAnalysis",
      expect.any(String),
      { saleId },
    );
    expect(mocks.saleForDoor).toHaveBeenCalledWith(auth, saleId, "unlock");
    expect(mocks.environment).toHaveBeenCalledWith({
      address: "3 rue de la Paix, 69001, Lyon",
      lat: 45.76,
      lng: 4.83,
    });
    expect(JSON.stringify(mocks.environment.mock.calls)).not.toContain("Champs");
  });

  it("refuses a sale the free account did not unlock", async () => {
    mocks.entitlement.mockRejectedValue(
      new ForbiddenError("Contexte environnemental réservé à l’offre Analyse."),
    );

    expect((await call({ saleId, ...freeAddress })).status).toBe(403);
    expect(mocks.saleForDoor).not.toHaveBeenCalled();
    expect(mocks.environment).not.toHaveBeenCalled();
  });
});
