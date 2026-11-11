import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));

import { FACT_REGISTRY_CHECKS, runFactRegistryCheckJob } from "@/lib/fact-registry-check";

type ReportOverrides = {
  truncated?: unknown;
  checks?: Record<string, unknown>;
};

/** Le rapport d'une base saine, tel que le rend `check_fact_registry_consistency`. */
function report(overrides: ReportOverrides = {}) {
  const checks: Record<string, unknown> = Object.fromEntries(
    FACT_REGISTRY_CHECKS.map((name) => [name, { active: false, count: 0, sale_ids: [] }]),
  );
  return {
    checked_at: "2026-11-17T05:28:04.120000+00:00",
    limit: 500,
    candidate_sales: 3,
    sales_checked: 3,
    truncated: false,
    held_sale_count: 2,
    held_field_count: 4,
    ...overrides,
    checks: { ...checks, ...overrides.checks },
  };
}

describe("contrôle quotidien du registre des pièces", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
  });

  it("déclenche le contrôle en base, sans lui passer ni rapport ni détail", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: report(), error: null });

    await runFactRegistryCheckJob();

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("sync_fact_registry_alerts");
  });

  it("résume une base saine : aucun contrôle levé", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: report(), error: null });

    await expect(runFactRegistryCheckJob()).resolves.toEqual({
      checkedAt: "2026-11-17T05:28:04.120000+00:00",
      salesChecked: 3,
      heldSaleCount: 2,
      heldFieldCount: 4,
      counts: Object.fromEntries(FACT_REGISTRY_CHECKS.map((name) => [name, 0])),
      raised: [],
      alert: "clear",
    });
  });

  it("nomme les contrôles levés, avec leur compte, et jamais les identifiants de vente", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: report({
        checks: {
          echo_suppressed: {
            active: true,
            count: 2,
            total: 5,
            window_hours: 48,
            sale_ids: ["88900000-1000-4000-8000-000000000002"],
          },
          triggers_not_always: {
            active: true,
            count: 1,
            triggers: ["auction_sales.aaab_auction_sales_hold_projected_fields"],
          },
        },
      }),
      error: null,
    });

    const summary = await runFactRegistryCheckJob();

    expect(summary.raised).toEqual(["triggers_not_always", "echo_suppressed"]);
    expect(summary.alert).toBe("open");
    expect(summary.counts).toMatchObject({ echo_suppressed: 2, triggers_not_always: 1 });
    expect(JSON.stringify(summary)).not.toContain("88900000-1000-4000-8000-000000000002");
  });

  it.each(["PGRST202", "42883"])(
    "ne contrôle rien, et le dit, tant que la migration n'est pas appliquée (%s)",
    async (code) => {
      mocks.rpc.mockResolvedValueOnce({ data: null, error: { code, message: "missing" } });

      await expect(runFactRegistryCheckJob()).resolves.toEqual({ skipped: "migration_pending" });
    },
  );

  it("échoue sur toute autre erreur de la base", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "55000", message: "registry_unavailable" },
    });

    await expect(runFactRegistryCheckJob()).rejects.toThrow("registry_unavailable");
  });

  it("échoue sur un rapport tronqué au lieu de le faire passer pour complet", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: report({ truncated: true }), error: null });

    await expect(runFactRegistryCheckJob()).rejects.toThrow("rapport partiel");
  });

  it.each([
    ["nul", null],
    ["un tableau", []],
    ["sans contrôles", { truncated: false }],
  ])("échoue sur un rapport illisible (%s)", async (_label, data) => {
    mocks.rpc.mockResolvedValueOnce({ data, error: null });

    await expect(runFactRegistryCheckJob()).rejects.toThrow("rapport illisible");
  });

  it("échoue quand un contrôle manque au rapport, ou n'a ni état ni compte", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: report({ checks: { stale_listing: { active: "non", count: 0 } } }),
      error: null,
    });

    await expect(runFactRegistryCheckJob()).rejects.toThrow("contrôle stale_listing absent");
  });

  it("échoue quand le rapport ne dit pas s'il est complet", async () => {
    const incomplete: Record<string, unknown> = report();
    delete incomplete.truncated;
    mocks.rpc.mockResolvedValueOnce({ data: incomplete, error: null });

    await expect(runFactRegistryCheckJob()).rejects.toThrow("rapport partiel");
  });
});
