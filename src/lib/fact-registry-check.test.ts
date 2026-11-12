import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));

import {
  FACT_REGISTRY_CHECKS,
  REPROJECTION_PASS_START_BUDGET_MS,
  runFactRegistryCheckJob,
} from "@/lib/fact-registry-check";
import {
  isTransientError,
  runMonitoredJob,
  withTransientRetries,
} from "@/lib/monitored-job.server";

type ReportOverrides = {
  truncated?: unknown;
  pages?: unknown;
  merge_carried?: unknown;
  decisions_second_factor_required?: unknown;
  simulation_failures?: unknown;
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
  passes: 1,
  drifted: 0,
  applied: 0,
  busy: 0,
  failed: 0,
  bounded: false,
  failureCodes: [],
};

/** Les appels de la tâche, dans l'ordre : la relance (une réponse par passe), puis le contrôle. */
function answer(...responses: unknown[]) {
  for (const response of responses) mocks.rpc.mockResolvedValueOnce(response);
}

describe("contrôle quotidien du registre des pièces", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
      decisionsSecondFactorRequired: null,
      simulationFailureCodes: [],
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
          bounded: false,
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
          decisions_second_factor_required: false,
          simulation_failures: [
            { sale_id: "88900000-1000-4000-8000-000000000104", sqlstate: "22007" },
            { sale_id: "88900000-1000-4000-8000-000000000105", sqlstate: "22007" },
          ],
          checks: {
            reprojection_enabled: { active: true, count: 1 },
            final_decisions: { active: true, count: 2, window_hours: 24 },
            final_decisions_over_limit: { active: false, count: 0, limit: 5, window_hours: 24 },
          },
        }),
        error: null,
      },
    );

    const summary = await runFactRegistryCheckJob();

    expect(summary).toMatchObject({
      pages: 2,
      mergeCarried24h: 4,
      decisionsSecondFactorRequired: false,
      simulationFailureCodes: ["22007"],
      raised: ["reprojection_enabled", "final_decisions"],
      alert: "open",
      reprojection: {
        enabled: true,
        passes: 1,
        drifted: 33,
        applied: 30,
        busy: 1,
        failed: 2,
        bounded: false,
        failureCodes: ["23514", "23514:auction_sales_rooms_check"],
      },
    });
    expect(summary.counts).toMatchObject({
      reprojection_enabled: 1,
      final_decisions: 2,
      final_decisions_over_limit: 0,
    });
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

  const refused = {
    data: null,
    error: {
      code: "23514",
      message:
        'new row for relation "auction_sales" violates check constraint "x": Failing row contains (secret)',
    },
  };

  it("échoue sur une erreur de la base au contrôle, sans recopier son message", async () => {
    answer({ data: reprojection(), error: null }, refused);

    const thrown = await runFactRegistryCheckJob().catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      "Contrôle du registre des pièces : étape check, code 23514.",
    );
    expect(isTransientError(thrown)).toBe(false);
  });

  it("contrôle quand même après une relance en échec, puis échoue en disant les deux étapes", async () => {
    answer(refused, {
      data: report({ checks: { projection_drift: { active: true, count: 3, sale_ids: [] } } }),
      error: null,
    });

    const thrown = await runFactRegistryCheckJob().catch((error: unknown) => error);

    expect(mocks.rpc.mock.calls).toEqual([
      ["reproject_fact_registry_drift"],
      ["sync_fact_registry_alerts"],
    ]);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      "Contrôle du registre des pièces : étape reprojection, code 23514. " +
        "Contrôle fait ensuite : 1 contrôle(s) levé(s) (projection_drift).",
    );
    expect((thrown as Error).message).not.toContain("secret");
    expect(isTransientError(thrown)).toBe(false);
  });

  it("dit les deux échecs quand la relance et le contrôle échouent", async () => {
    answer(refused, { data: null, error: { code: "42501", message: "permission denied" } });

    await expect(runFactRegistryCheckJob()).rejects.toThrow(
      "Contrôle du registre des pièces : étape reprojection, code 23514. " +
        "Contrôle du registre des pièces : étape check, code 42501.",
    );
  });

  it("ne recopie pas un code d'erreur qui n'en a pas la forme", async () => {
    answer(
      { data: null, error: { code: "une phrase avec une valeur 54", message: "x" } },
      { data: report(), error: null },
    );

    await expect(runFactRegistryCheckJob()).rejects.toThrow(
      "Contrôle du registre des pièces : étape reprojection, code inconnu. " +
        "Contrôle fait ensuite : aucun contrôle levé.",
    );
  });

  it("échoue sur un compte rendu de relance illisible, après avoir contrôlé", async () => {
    answer({ data: { applied: 3 }, error: null }, { data: report(), error: null });

    await expect(runFactRegistryCheckJob()).rejects.toThrow("compte rendu de la relance illisible");
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["la relance", true],
    ["le contrôle", false],
  ])(
    "est reprise après une panne de réseau (fetch failed sur %s, puis succès)",
    async (_step, first) => {
      const networkFailure = {
        data: null,
        error: { code: "", message: "TypeError: fetch failed" },
      };
      if (first) answer(networkFailure, { data: report(), error: null });
      else answer({ data: reprojection(), error: null }, networkFailure);
      answer({ data: reprojection(), error: null }, { data: report(), error: null });
      const retried: string[] = [];

      const run = { startedAt: Date.now(), attempts: 0 };
      const summary = await withTransientRetries(
        () => runFactRegistryCheckJob(run),
        [0],
        (_attempt, error) => retried.push((error as Error).message),
      );

      expect(summary.alert).toBe("clear");
      expect(mocks.rpc).toHaveBeenCalledTimes(4);
      expect(retried).toHaveLength(1);
      // Le message enregistré reste nettoyé : l'étape et un code, rien du message d'origine.
      expect(retried[0]).toContain("code inconnu.");
      expect(retried[0]).not.toContain("fetch failed");
    },
  );

  it.each([
    ["57014", "canceling statement due to statement timeout", false],
    ["23514", "upstream answered 503, network 429", false],
    ["40001", "could not serialize access", true],
    ["40P01", "deadlock detected", true],
  ])("classe une erreur par son code seul (%s)", async (code, message, transient) => {
    answer({ data: reprojection(), error: null }, { data: null, error: { code, message } });

    const thrown = await runFactRegistryCheckJob().catch((error: unknown) => error);

    expect((thrown as Error).message).toBe(
      `Contrôle du registre des pièces : étape check, code ${code}.`,
    );
    expect(isTransientError(thrown)).toBe(transient);
  });

  it("ne demande pas de reprise quand il ne reste plus la place d'une tentative entière", async () => {
    const start = 1_000_000;
    // Panne de réseau 51 s après le début : 51 + 5 (attente) + 240 (une passe et le contrôle) dépasse 295 s.
    vi.spyOn(Date, "now").mockReturnValue(start + 51_000);
    answer(
      { data: reprojection(), error: null },
      { data: null, error: { code: "", message: "TypeError: fetch failed" } },
    );

    const thrown = await runFactRegistryCheckJob({ startedAt: start, attempts: 0 }).catch(
      (error: unknown) => error,
    );

    expect((thrown as Error).message).toBe(
      "Contrôle du registre des pièces : étape check, code inconnu.",
    );
    expect(isTransientError(thrown)).toBe(false);
  });

  it("ne demande pas de troisième reprise : son attente de 60 s ne laisse pas une tentative entière", async () => {
    const networkFailure = { data: null, error: { code: "", message: "TypeError: fetch failed" } };
    answer(networkFailure, { data: report(), error: null });

    const run = { startedAt: Date.now(), attempts: 2 };
    const thrown = await runFactRegistryCheckJob(run).catch((error: unknown) => error);

    expect(isTransientError(thrown)).toBe(false);
  });

  it("contrôle coupé à 120 s : une seule exécution, en échec avec son code, en moins de 300 s", async () => {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      const calls: string[] = [];
      let finished: Record<string, unknown> | null = null;
      mocks.rpc.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
        calls.push(name);
        if (name === "begin_operational_job_run") return { data: "run-1", error: null };
        if (name === "finish_operational_job_run") {
          finished = args ?? null;
          return { data: null, error: null };
        }
        if (name === "reproject_fact_registry_drift") return { data: reprojection(), error: null };
        // Le contrôle atteint le délai d'instruction de la base.
        await vi.advanceTimersByTimeAsync(120_000);
        return {
          data: null,
          error: { code: "57014", message: "canceling statement due to statement timeout" },
        };
      });
      const run = { startedAt: start, attempts: 0 };

      const outcome = await runMonitoredJob("fact-registry-check", () =>
        runFactRegistryCheckJob(run),
      );

      expect(outcome).toMatchObject({
        ok: false,
        message: "Contrôle du registre des pièces : étape check, code 57014.",
      });
      expect(calls.filter((name) => name === "sync_fact_registry_alerts")).toHaveLength(1);
      expect(calls.filter((name) => name === "finish_operational_job_run")).toHaveLength(1);
      expect(finished).toMatchObject({
        p_status: "failed",
        p_error_message: "Contrôle du registre des pièces : étape check, code 57014.",
      });
      expect(Date.now() - start).toBeLessThan(300_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("panne de réseau répétée : les reprises s'arrêtent avant la durée de la route", async () => {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      const calls: string[] = [];
      mocks.rpc.mockImplementation(async (name: string) => {
        calls.push(name);
        if (name === "begin_operational_job_run") return { data: "run-1", error: null };
        if (name === "finish_operational_job_run") return { data: null, error: null };
        if (name === "reproject_fact_registry_drift") return { data: reprojection(), error: null };
        // Chaque contrôle met 20 s à échouer sur le réseau.
        vi.setSystemTime(Date.now() + 20_000);
        return { data: null, error: { code: "", message: "TypeError: fetch failed" } };
      });
      const run = { startedAt: start, attempts: 0 };

      const pending = runMonitoredJob("fact-registry-check", () => runFactRegistryCheckJob(run));
      await vi.runAllTimersAsync();
      const outcome = await pending;

      expect(outcome.ok).toBe(false);
      // 20 s, attente de 5 s, 20 s : à 45 s la deuxième reprise (attente de 20 s) n'a plus sa place.
      expect(calls.filter((name) => name === "sync_fact_registry_alerts")).toHaveLength(2);
      expect(Date.now() - start).toBeLessThan(300_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enchaîne les passes de la relance tant que la base dit qu'il en reste", async () => {
    answer(
      {
        data: reprojection({ enabled: true, drifted: 65, applied: 30, bounded: true }),
        error: null,
      },
      {
        data: reprojection({
          enabled: true,
          drifted: 35,
          applied: 30,
          failed: 1,
          bounded: true,
          failures: [{ sale_id: "88900000-1000-4000-8000-000000000101", sqlstate: "23514" }],
        }),
        error: null,
      },
      {
        data: reprojection({ enabled: true, drifted: 5, applied: 5, busy: 1, bounded: false }),
        error: null,
      },
      { data: report(), error: null },
    );

    const summary = await runFactRegistryCheckJob();

    expect(mocks.rpc.mock.calls).toEqual([
      ["reproject_fact_registry_drift"],
      ["reproject_fact_registry_drift"],
      ["reproject_fact_registry_drift"],
      ["sync_fact_registry_alerts"],
    ]);
    expect(summary.reprojection).toEqual({
      enabled: true,
      passes: 3,
      drifted: 65,
      applied: 65,
      busy: 1,
      failed: 0,
      bounded: false,
      failureCodes: ["23514"],
    });
  });

  it("n'enchaîne pas une passe de plus quand le temps réservé au contrôle est entamé", async () => {
    const start = 1_000_000;
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(start)
      .mockReturnValueOnce(start + REPROJECTION_PASS_START_BUDGET_MS - 1)
      .mockReturnValue(start + REPROJECTION_PASS_START_BUDGET_MS);
    const bounded = {
      data: reprojection({ enabled: true, drifted: 90, applied: 30, bounded: true }),
      error: null,
    };
    answer(bounded, bounded, { data: report(), error: null });

    const summary = await runFactRegistryCheckJob();

    expect(mocks.rpc).toHaveBeenCalledTimes(3);
    expect(summary.reprojection).toMatchObject({ passes: 2, applied: 60, bounded: true });
  });

  it("n'enchaîne pas après une passe qui n'a rien écrit (ventes occupées)", async () => {
    answer(
      {
        data: reprojection({ enabled: true, drifted: 3, applied: 0, busy: 3, bounded: true }),
        error: null,
      },
      { data: report(), error: null },
    );

    const summary = await runFactRegistryCheckJob();

    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(summary.reprojection).toMatchObject({ passes: 1, applied: 0, busy: 3, bounded: true });
  });

  it("échoue, après le contrôle, quand une passe suivante de la relance échoue", async () => {
    answer(
      {
        data: reprojection({ enabled: true, drifted: 40, applied: 30, bounded: true }),
        error: null,
      },
      { data: null, error: { code: "PGRST202", message: "missing" } },
      { data: report(), error: null },
    );

    await expect(runFactRegistryCheckJob()).rejects.toThrow(
      "étape reprojection, code PGRST202. Contrôle fait ensuite : aucun contrôle levé.",
    );
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
