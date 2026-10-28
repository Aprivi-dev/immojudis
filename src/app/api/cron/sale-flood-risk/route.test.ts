import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runSaleFloodRiskBatch: vi.fn(),
  runMonitoredCron: vi.fn(),
  dispatchSaleFloodRiskWorkflow: vi.fn(),
}));

vi.mock("@/lib/cron-jobs", async () => ({
  positiveNumberFromEnv: (
    await vi.importActual<typeof import("@/lib/cron-jobs")>("@/lib/cron-jobs")
  ).positiveNumberFromEnv,
  runMonitoredCron: mocks.runMonitoredCron,
}));
vi.mock("@/lib/sale-flood-risk-batch", () => ({
  runSaleFloodRiskBatch: mocks.runSaleFloodRiskBatch,
}));
vi.mock("@/lib/sale-flood-risk-dispatch.server", async () => ({
  saleFloodRiskRunsOnVercel: (
    await vi.importActual<typeof import("@/lib/sale-flood-risk-dispatch.server")>(
      "@/lib/sale-flood-risk-dispatch.server",
    )
  ).saleFloodRiskRunsOnVercel,
  dispatchSaleFloodRiskWorkflow: mocks.dispatchSaleFloodRiskWorkflow,
}));

import { GET, maxDuration } from "./route";

describe("sale flood risk cron route", () => {
  beforeEach(() => {
    // Ces cas décrivent la passe dans la route (retour arrière) ; le déclenchement par défaut est testé plus bas.
    process.env.SALE_FLOOD_RISK_RUNNER = "vercel";
  });
  afterEach(() => {
    mocks.runSaleFloodRiskBatch.mockReset();
    mocks.runMonitoredCron.mockReset();
    mocks.dispatchSaleFloodRiskWorkflow.mockReset();
    delete process.env.SALE_FLOOD_RISK_BATCH_LIMIT;
    delete process.env.SALE_FLOOD_RISK_RUNNER;
  });

  function runHandler() {
    mocks.runMonitoredCron.mockImplementationOnce(
      async (
        _request: Request,
        _jobName: string,
        handler: () => Promise<Record<string, unknown>>,
      ) => Response.json(await handler()),
    );
    return GET(new Request("https://example.test/api/cron/sale-flood-risk"));
  }

  it("passe par la supervision des tâches planifiées, sous le nom de la tâche", async () => {
    mocks.runSaleFloodRiskBatch.mockResolvedValueOnce({ evaluated: 3 });

    const response = await runHandler();

    expect(await response.json()).toEqual({ evaluated: 3 });
    expect(mocks.runMonitoredCron).toHaveBeenCalledTimes(1);
    expect(mocks.runMonitoredCron.mock.calls[0][1]).toBe("sale-flood-risk");
    expect(mocks.runSaleFloodRiskBatch).toHaveBeenCalledWith({ limit: 150 });
  });

  it("ne diffère aucune reprise : elle ajouterait du temps à une route bornée par maxDuration", async () => {
    mocks.runSaleFloodRiskBatch.mockResolvedValueOnce({});

    await runHandler();

    expect(mocks.runMonitoredCron.mock.calls[0][3]).toMatchObject({ retryDelaysMs: [] });
  });

  it("lit la taille du lot dans l'environnement", async () => {
    process.env.SALE_FLOOD_RISK_BATCH_LIMIT = "120";
    mocks.runSaleFloodRiskBatch.mockResolvedValueOnce({});

    await runHandler();

    expect(mocks.runSaleFloodRiskBatch).toHaveBeenCalledWith({ limit: 120 });
  });

  it.each(["0", "-3", "abc", "  "])(
    "revient à 150 ventes quand la taille de lot de l'environnement est %j",
    async (value) => {
      process.env.SALE_FLOOD_RISK_BATCH_LIMIT = value;
      mocks.runSaleFloodRiskBatch.mockResolvedValueOnce({});

      await runHandler();

      expect(mocks.runSaleFloodRiskBatch).toHaveBeenCalledWith({ limit: 150 });
    },
  );

  it("par défaut, ne fait que déclencher le workflow GitHub, suivi sous un autre nom que la passe", async () => {
    delete process.env.SALE_FLOOD_RISK_RUNNER;
    mocks.dispatchSaleFloodRiskWorkflow.mockResolvedValueOnce({ dispatched: true });

    const response = await runHandler();

    expect(await response.json()).toEqual({ dispatched: true });
    // La passe est supervisée par le workflow sous « sale-flood-risk » : le déclenchement ne doit pas la valider.
    expect(mocks.runMonitoredCron.mock.calls[0][1]).toBe("sale-flood-risk-dispatch");
    expect(mocks.runSaleFloodRiskBatch).not.toHaveBeenCalled();
  });

  it.each([
    ["déclenchement GitHub (défaut)", undefined],
    ["passe dans la route", "vercel"],
  ])(
    "%s : le filet quotidien ne fait rien si la passe « sale-flood-risk » a réussi dans les 2 h",
    async (_label, runner) => {
      if (runner) process.env.SALE_FLOOD_RISK_RUNNER = runner;
      else delete process.env.SALE_FLOOD_RISK_RUNNER;
      mocks.dispatchSaleFloodRiskWorkflow.mockResolvedValueOnce({ dispatched: true });
      mocks.runSaleFloodRiskBatch.mockResolvedValueOnce({});

      await runHandler();

      // Le déclenchement réussit même quand le workflow échoue : c'est la passe, écrite par le workflow, qui compte.
      expect(mocks.runMonitoredCron.mock.calls[0][3]).toMatchObject({
        catchUpSchedule: "35 5 * * *",
        catchUpSuccessWindowHours: 2,
        catchUpSuccessJobName: "sale-flood-risk",
      });
    },
  );

  it("laisse cinq minutes à l'exécution", () => {
    expect(maxDuration).toBe(300);
  });
});
