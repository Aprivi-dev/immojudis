import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runSaleFloodRiskBatch: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/operational-alerts", () => ({ deliverOperationalAlertNotifications: vi.fn() }));
vi.mock("@/lib/sale-flood-risk-batch", () => ({
  runSaleFloodRiskBatch: mocks.runSaleFloodRiskBatch,
}));

import { GET } from "./route";

describe("route planifiée du risque d’inondation : protection", () => {
  it("refuse une requête sans jeton et ne calcule rien", async () => {
    vi.stubEnv("CRON_SECRET", "secret-de-test");

    const response = await GET(new Request("https://example.test/api/cron/sale-flood-risk"));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, code: "AUTH_REQUIRED" });
    expect(mocks.runSaleFloodRiskBatch).not.toHaveBeenCalled();
  });

  it("refuse un mauvais jeton", async () => {
    vi.stubEnv("CRON_SECRET", "secret-de-test");

    const response = await GET(
      new Request("https://example.test/api/cron/sale-flood-risk", {
        headers: { authorization: "Bearer autre-jeton" },
      }),
    );

    expect(response.status).toBe(401);
    expect(mocks.runSaleFloodRiskBatch).not.toHaveBeenCalled();
  });
});
