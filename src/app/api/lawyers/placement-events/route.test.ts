import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), entitlement: vi.fn(), record: vi.fn() }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/property-reports", () => ({ assertFeatureEntitlement: mocks.entitlement }));
vi.mock("@/lib/lawyer-placement-events", () => ({
  lawyerPlacementEventInputSchema: { parse: (value: unknown) => value },
  recordLawyerPlacementEvent: mocks.record,
}));

import { POST } from "./route";

describe("POST /api/lawyers/placement-events", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.auth.mockResolvedValue({ userId: "user-1" });
  });

  it("vérifie le droit à l'annuaire, inclus dans l'offre Découverte, avec un message exact", async () => {
    mocks.record.mockResolvedValue({ recorded: true });
    const response = await POST(
      new Request("https://example.test/api/lawyers/placement-events", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.entitlement).toHaveBeenCalledWith(
      { userId: "user-1" },
      "lawyers.directory",
      "Annuaire des avocats indisponible pour ce compte.",
    );
  });

  it("ne dit plus que les avocats référencés sont réservés à l’offre Analyse", async () => {
    mocks.entitlement.mockRejectedValue(
      new Error("Annuaire des avocats indisponible pour ce compte."),
    );
    const response = await POST(
      new Request("https://example.test/api/lawyers/placement-events", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("réservés à l’offre Analyse");
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
