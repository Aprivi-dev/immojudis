import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));

import { FACT_REGISTRY_CHECKS, runFactRegistryCheckJob } from "@/lib/fact-registry-check";

type ReportOverrides = {
  truncated?: unknown;
  pages?: unknown;
  merge_carried?: unknown;
  checks?: Record<string, unknown>;
};

/** Le rapport d'une base saine, tel que le rend `sync_fact_registry_alerts` au lot R2a. */
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

/** Le compte rendu de la relance planifiée, fermée, tel que le rend `reproject_fact_registry_drift`. */
function reprojection(overrides: Record<string, unknown> = {}) {
  return {
    enabled: false,
    max: 30,
    drifted: 0,
    applied: 0,
    busy: 0,
    failed: 0,
    failures: [],
    bounded: false,
    ...overrides,
  };
}

const closedReprojection = {
  enabled: false,
  drifted: 0,
  applied: 0,
  busy: 0,
  failed: 0,
  bounded: false,
  failureCodes: [],
};

/** Les deux appels de la tâche, dans l'ordre : la relance, puis le contrôle. */
function answer(reprojected: unknown, checked: unknown) {
  mocks.rpc.mockResolvedValueOnce(reprojected).mockResolvedValueOnce(checked);
}

describe("contrôle quotidien du registre des pièces", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
  });

  it("lance la relance puis le contrôle, en deux appels sans paramètre", async () => {
    answer({ data: reprojection(), error: null }, { data: report(), error: null });

    await runFactRegistryCheckJob();

    expect(mocks.rpc.mock.calls).toEqual([
      ["reproject_fact_registry_drift"],
      ["sync_fact_registry_alerts"],
    ]);
  });

  it("résume une base saine : aucun contrôle levé, relance fermée", async () => {
    answer({ data: reprojection(), error: null }, { data: report(), error: null });

    await expect(runFactRegistryCheckJob()).resolves.toEqual({
      checkedAt: "2026-11-17T05:28:04.120000+00:00",
      salesChecked: 3,
      heldSaleCount: 2,
      heldFieldCount: 4,
      pages: null,
      mergeCarried24h: null,
      counts: Object.fromEntries(FACT_REGISTRY_CHECKS.map((name) => [name, 0])),
      raised: [],
      alert: "clear",
      reprojection: closedReprojection,
    });
  });

  it("recopie les pages, les pièces reportées, l'état de l'interrupteur et le compte rendu de la relance", async () => {
    answer(
      {
        data: reprojection({
          enabled: true,
          drifted: 33,
          applied: 30,
          busy: 1,
          failed: 2,
          bounded: true,
          failures: [
            {
              sale_id: "88900000-1000-4000-8000-000000000101",
              sqlstate: "23514",
              constraint: "auction_sales_rooms_check",
            },
            { sale_id: "88900000-1000-4000-8000-000000000102", sqlstate: "23514" },
            {
              sale_id: "88900000-1000-4000-8000-000000000103",
              sqlstate: "23514",
              constraint: "auction_sales_rooms_check",
            },
          ],
        }),
        error: null,
      },
      {
        data: report({
          pages: 2,
          merge_carried: { count: 4, window_hours: 24 },
          checks: { reprojection_enabled: { active: true, count: 1 } },
        }),
        error: null,
      },
    );

    const summary = await runFactRegistryCheckJob();

    expect(summary).toMatchObject({
      pages: 2,
      mergeCarried24h: 4,
      raised: ["reprojection_enabled"],
      alert: "open",
      reprojection: {
        enabled: true,
        drifted: 33,
        applied: 30,
        busy: 1,
        failed: 2,
        bounded: true,
        failureCodes: ["23514", "23514:auction_sales_rooms_check"],
      },
    });
    expect(summary.counts).toMatchObject({ reprojection_enabled: 1 });
    expect(JSON.stringify(summary)).not.toContain("88900000-1000-4000-8000");
  });

  it("nomme les contrôles levés, avec leur compte, et jamais les identifiants de vente", async () => {
    answer(
      { data: reprojection(), error: null },
      {
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
      },
    );

    const summary = await runFactRegistryCheckJob();

    expect(summary.raised).toEqual(["triggers_not_always", "echo_suppressed"]);
    expect(summary.alert).toBe("open");
    expect(summary.counts).toMatchObject({ echo_suppressed: 2, triggers_not_always: 1 });
    expect(JSON.stringify(summary)).not.toContain("88900000-1000-4000-8000-000000000002");
  });

  it.each(["PGRST202", "42883"])(
    "ne contrôle rien, et le dit, tant que la migration du contrôle n'est pas appliquée (%s)",
    async (code) => {
      const missing = { data: null, error: { code, message: "missing" } };
      answer(missing, missing);

      await expect(runFactRegistryCheckJob()).resolves.toEqual({ skipped: "migration_pending" });
    },
  );

  it.each(["PGRST202", "42883"])(
    "contrôle sans relancer, et le dit, tant que la migration de la relance n'est pas appliquée (%s)",
    async (code) => {
      answer({ data: null, error: { code, message: "missing" } }, { data: report(), error: null });

      const summary = await runFactRegistryCheckJob();

      expect(summary.reprojection).toEqual({ skipped: "migration_pending" });
      expect(summary.alert).toBe("clear");
      expect(mocks.rpc).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["reprojection", true],
    ["check", false],
  ])(
    "échoue sur toute autre erreur de la base (étape %s) sans recopier son message",
    async (step, first) => {
      const failure = {
        data: null,
        error: {
          code: "23514",
          message:
            'new row for relation "auction_sales" violates check constraint "x": Failing row contains (secret)',
        },
      };
      if (first) mocks.rpc.mockResolvedValueOnce(failure);
      else answer({ data: reprojection(), error: null }, failure);

      const thrown = await runFactRegistryCheckJob().catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(
        `Contrôle du registre des pièces : étape ${step}, code 23514.`,
      );
      expect((thrown as Error).message).not.toContain("secret");
      // Une relance en échec arrête la tâche : le contrôle ne tourne pas sur un état inconnu.
      expect(mocks.rpc).toHaveBeenCalledTimes(first ? 1 : 2);
    },
  );

  it("ne recopie pas un code d'erreur qui n'en a pas la forme", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "une phrase avec une valeur 54", message: "x" },
    });

    await expect(runFactRegistryCheckJob()).rejects.toThrow(
      "Contrôle du registre des pièces : étape reprojection, code inconnu.",
    );
  });

  it("échoue sur un compte rendu de relance illisible", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { applied: 3 }, error: null });

    await expect(runFactRegistryCheckJob()).rejects.toThrow("compte rendu de la relance illisible");
  });

  it("échoue sur un rapport tronqué au lieu de le faire passer pour complet", async () => {
    answer(
      { data: reprojection(), error: null },
      { data: report({ truncated: true }), error: null },
    );

    await expect(runFactRegistryCheckJob()).rejects.toThrow("rapport partiel");
  });

  it("échoue sur un rapport tronqué même quand un contrôle y est levé", async () => {
    answer(
      { data: reprojection(), error: null },
      {
        data: report({
          truncated: true,
          checks: { projection_drift: { active: true, count: 1, sale_ids: [] } },
        }),
        error: null,
      },
    );

    await expect(runFactRegistryCheckJob()).rejects.toThrow("rapport partiel");
  });

  it("exige les dix contrôles du lot R2a, dans l'ordre de gravité de la base", () => {
    expect(FACT_REGISTRY_CHECKS).toEqual([
      "projection_drift",
      "triggers_not_always",
      "column_mismatch",
      "registry_label",
      "echo_suspected",
      "internal_column_copied",
      "events_burst",
      "echo_suppressed",
      "echo_blocked",
      "stale_listing",
    ]);
  });

  it.each([
    ["nul", null],
    ["un tableau", []],
    ["sans contrôles", { truncated: false }],
  ])("échoue sur un rapport illisible (%s)", async (_label, data) => {
    answer({ data: reprojection(), error: null }, { data, error: null });

    await expect(runFactRegistryCheckJob()).rejects.toThrow("rapport illisible");
  });

  it("échoue quand un contrôle manque au rapport, ou n'a ni état ni compte", async () => {
    answer(
      { data: reprojection(), error: null },
      {
        data: report({ checks: { stale_listing: { active: "non", count: 0 } } }),
        error: null,
      },
    );

    await expect(runFactRegistryCheckJob()).rejects.toThrow("contrôle stale_listing absent");
  });

  it("échoue quand le contrôle de la relance est dans le rapport sans état ni compte", async () => {
    answer(
      { data: reprojection(), error: null },
      { data: report({ checks: { reprojection_enabled: { active: true } } }), error: null },
    );

    await expect(runFactRegistryCheckJob()).rejects.toThrow("contrôle reprojection_enabled absent");
  });

  it("échoue quand le rapport ne dit pas s'il est complet", async () => {
    const incomplete: Record<string, unknown> = report();
    delete incomplete.truncated;
    answer({ data: reprojection(), error: null }, { data: incomplete, error: null });

    await expect(runFactRegistryCheckJob()).rejects.toThrow("rapport partiel");
  });
});
