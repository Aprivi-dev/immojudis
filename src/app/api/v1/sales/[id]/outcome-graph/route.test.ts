import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutcomeGraphForecast } from "@/lib/outcome-graph";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  assertEntitlement: vi.fn(),
  getForecast: vi.fn(),
  recordUsage: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: vi.fn(() => "token"),
  requireSupabaseAuthContext: mocks.requireAuth,
}));

vi.mock("@/lib/property-reports", () => ({
  assertFeatureEntitlement: mocks.assertEntitlement,
}));

vi.mock("@/lib/outcome-graph-repository", () => ({
  getOutcomeGraphForecastForSale: mocks.getForecast,
}));

vi.mock("@/lib/usage", () => ({
  recordFeatureUsageEvent: mocks.recordUsage,
}));

import { GET } from "@/app/api/v1/sales/[id]/outcome-graph/route";

const saleId = "11111111-1111-4111-8111-111111111111";
const auth = { userId: "premium-user" };
const forecast: OutcomeGraphForecast = {
  saleId,
  roundId: "22222222-2222-4222-8222-222222222222",
  predictionId: "33333333-3333-4333-8333-333333333333",
  snapshotId: "44444444-4444-4444-8444-444444444444",
  status: "ready",
  generatedAt: "2026-07-30T10:00:00.000Z",
  horizon: "T-7",
  modelVersion: "cohort_baseline_v1",
  cohort: {
    id: "55555555-5555-4555-8555-555555555555",
    label: "National · appartement",
    level: "national_property_type",
    periodStart: "2025-01-01T00:00:00.000Z",
    periodEnd: "2026-06-30T23:59:59.000Z",
  },
  marketValueCents: 24_000_000,
  startingPriceCents: 8_000_000,
  effectiveStartingPriceCents: 8_000_000,
  flow: {
    heldProbability: 0.78,
    postponedProbability: 0.14,
    cancelledOrNotRequestedProbability: 0.08,
    adjudicatedIfHeldProbability: 0.81,
    noBidIfHeldProbability: 0.19,
  },
  initialPrice: { p10Cents: 9_000_000, p50Cents: 12_000_000, p90Cents: 17_000_000 },
  surenchereProbability: 0.12,
  finalPrice: { p10Cents: 10_000_000, p50Cents: 13_500_000, p90Cents: 19_000_000 },
  ceiling: null,
  pressure: null,
  confidence: { label: "moyen", score: 0.66, sampleSize: 58, tribunalSampleSize: 12 },
  delays: null,
  explanationFactors: [],
  limitations: ["Prévision statistique, pas une garantie."],
  refusalReason: null,
};

function request(id = saleId) {
  return GET(new Request(`https://example.test/api/v1/sales/${id}/outcome-graph`), {
    params: Promise.resolve({ id }),
  });
}

describe("GET /api/v1/sales/:id/outcome-graph", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.requireAuth.mockResolvedValue(auth);
    mocks.assertEntitlement.mockResolvedValue(undefined);
    mocks.getForecast.mockResolvedValue(forecast);
    mocks.recordUsage.mockResolvedValue(undefined);
  });

  it("refuse une requête non authentifiée avant toute lecture du registre", async () => {
    mocks.requireAuth.mockRejectedValue(new Error("Unauthorized: missing bearer token"));

    const response = await request();

    expect(response.status).toBe(401);
    expect(mocks.assertEntitlement).not.toHaveBeenCalled();
    expect(mocks.getForecast).not.toHaveBeenCalled();
  });

  it("refuse Découverte avant toute lecture du registre", async () => {
    mocks.assertEntitlement.mockRejectedValue(
      new Error("Prévision Outcome Graph réservée au plan Analyse."),
    );

    const response = await request();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.assertEntitlement).toHaveBeenCalledWith(
      auth,
      "property.outcomeGraph",
      expect.stringContaining("Analyse"),
    );
    expect(mocks.getForecast).not.toHaveBeenCalled();
  });

  it("valide l’identifiant seulement après authentification et entitlement", async () => {
    const response = await request("not-a-uuid");

    expect(response.status).toBe(400);
    expect(mocks.assertEntitlement).toHaveBeenCalledOnce();
    expect(mocks.getForecast).not.toHaveBeenCalled();
  });

  it("renvoie une prévision privée et journalise uniquement ses identifiants publics", async () => {
    const response = await request();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ forecast });
    expect(mocks.getForecast).toHaveBeenCalledWith(saleId);
    expect(mocks.recordUsage).toHaveBeenCalledWith({
      auth,
      eventKey: "outcome_graph.viewed",
      subjectType: "auction_sale",
      subjectId: saleId,
      metadata: {
        status: "ready",
        model_version: forecast.modelVersion,
        prediction_id: forecast.predictionId,
        snapshot_id: forecast.snapshotId,
      },
    });
  });
});
