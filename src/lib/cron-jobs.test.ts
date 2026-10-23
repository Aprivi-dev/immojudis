import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deliverOperationalAlertNotifications: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));
vi.mock("@/lib/operational-alerts", () => ({
  deliverOperationalAlertNotifications: mocks.deliverOperationalAlertNotifications,
}));

import {
  evaluateOperationalHealth,
  operationalErrorMessage,
  runDataRetention,
  runMonitoredCron,
} from "@/lib/cron-jobs";

describe("operational cron errors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.deliverOperationalAlertNotifications.mockReset();
    mocks.rpc.mockReset();
    delete process.env.CRON_SECRET;
  });

  it("preserves structured PostgREST errors for operators", () => {
    expect(
      operationalErrorMessage({
        message: "permission denied for table user_profiles",
        details: "service_role cannot select rows",
        hint: null,
        code: "42501",
      }),
    ).toBe("permission denied for table user_profiles · service_role cannot select rows · 42501");
  });

  it("keeps a safe fallback for opaque failures", () => {
    expect(operationalErrorMessage({ unexpected: true })).toBe("Scheduled job failed");
  });

  it("fails health when no external alert channel is configured", async () => {
    mocks.rpc.mockResolvedValue({ data: {}, error: null });
    mocks.deliverOperationalAlertNotifications.mockResolvedValue({
      channel: null,
      configured: false,
      claimed: 0,
      delivered: 0,
      failed: 0,
    });

    await expect(evaluateOperationalHealth(new Date("2026-10-09T10:00:00.000Z"))).rejects.toThrow(
      "No external operational alert channel is configured.",
    );
    expect(mocks.deliverOperationalAlertNotifications).toHaveBeenCalledTimes(1);
  });

  it("fails health when an external alert delivery fails", async () => {
    mocks.rpc.mockResolvedValue({ data: {}, error: null });
    mocks.deliverOperationalAlertNotifications.mockResolvedValue({
      channel: "github_actions",
      configured: true,
      claimed: 2,
      delivered: 1,
      failed: 1,
    });

    await expect(evaluateOperationalHealth(new Date("2026-10-09T10:00:00.000Z"))).rejects.toThrow(
      "1 external operational alert delivery(ies) failed.",
    );
  });

  it("returns health data when the existing alert channel is configured", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
    mocks.deliverOperationalAlertNotifications.mockResolvedValue({
      channel: "github_actions",
      configured: true,
      claimed: 0,
      delivered: 0,
      failed: 0,
    });

    await expect(evaluateOperationalHealth(new Date("2026-10-09T10:00:00.000Z"))).resolves.toEqual({
      health: { ok: true },
      valuation: { ok: true },
      pipeline: { ok: true },
      informationAgent: { ok: true },
      externalAlerts: {
        channel: "github_actions",
        configured: true,
        claimed: 0,
        delivered: 0,
        failed: 0,
      },
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(4);
    expect(mocks.rpc).toHaveBeenCalledWith("evaluate_information_agent_health", {
      p_now: "2026-10-09T10:00:00.000Z",
    });
  });

  it("ignores a missing information-agent evaluation (migration not applied yet) but not other failures", async () => {
    mocks.deliverOperationalAlertNotifications.mockResolvedValue({
      channel: "github_actions",
      configured: true,
      claimed: 0,
      delivered: 0,
      failed: 0,
    });
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "evaluate_information_agent_health"
        ? { data: null, error: { code: "PGRST202", message: "Could not find the function" } }
        : { data: { ok: true }, error: null },
    );

    await expect(
      evaluateOperationalHealth(new Date("2026-10-09T10:00:00.000Z")),
    ).resolves.toMatchObject({
      health: { ok: true },
      informationAgent: {},
    });

    mocks.rpc.mockImplementation(async (name: string) =>
      name === "evaluate_information_agent_health"
        ? { data: null, error: { code: "XX000", message: "boom" } }
        : { data: { ok: true }, error: null },
    );
    await expect(evaluateOperationalHealth(new Date("2026-10-09T10:00:00.000Z"))).rejects.toThrow(
      "boom",
    );

    // Une autre évaluation absente reste une erreur.
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "evaluate_operational_health"
        ? { data: null, error: { code: "PGRST202", message: "missing health" } }
        : { data: { ok: true }, error: null },
    );
    await expect(evaluateOperationalHealth(new Date("2026-10-09T10:00:00.000Z"))).rejects.toThrow(
      "missing health",
    );
  });

  /** `run_data_retention` répond `retention` ; la purge du journal du préavis répond `noticePurge`. */
  function retentionRpc(retention: unknown, noticePurge: unknown = { data: 0, error: null }) {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "purge_launch_offer_end_notices" ? noticePurge : { data: retention, error: null },
    );
  }

  it("reports a clean data retention run", async () => {
    retentionRpc({ user_sale_unlocks: 2 }, { data: 4, error: null });

    await expect(runDataRetention(new Date("2026-10-15T10:00:00.000Z"))).resolves.toEqual({
      deleted: { user_sale_unlocks: 2, launch_offer_end_notices: 4 },
    });
    expect(mocks.rpc).toHaveBeenCalledWith("run_data_retention", {
      p_now: "2026-10-15T10:00:00.000Z",
    });
    expect(mocks.rpc).toHaveBeenCalledWith("purge_launch_offer_end_notices");
  });

  it("fails the data retention job when an isolated purge failed", async () => {
    retentionRpc({ information_agent_contacts: 3, purge_errors: { purge_sale_unlocks: "57014" } });

    await expect(runDataRetention()).rejects.toThrow(
      "Data retention: purge failed: purge_sale_unlocks (57014).",
    );
  });

  it("ignores an empty purge_errors report", async () => {
    retentionRpc({ purge_errors: {} });

    await expect(runDataRetention()).resolves.toEqual({
      deleted: { purge_errors: {}, launch_offer_end_notices: 0 },
    });
  });

  it("ignores a missing notice journal purge (migration not applied yet) but not other failures", async () => {
    retentionRpc(
      { user_sale_unlocks: 2 },
      { data: null, error: { code: "PGRST202", message: "Could not find the function" } },
    );
    await expect(runDataRetention()).resolves.toEqual({ deleted: { user_sale_unlocks: 2 } });

    retentionRpc(
      { user_sale_unlocks: 2 },
      { data: null, error: { code: "XX000", message: "boom" } },
    );
    await expect(runDataRetention()).rejects.toThrow("purge_launch_offer_end_notices");
  });

  it("rejects unauthorized calls with a safe request id and a structured log", async () => {
    process.env.CRON_SECRET = "cron-test-secret";
    const warningLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handler = vi.fn();

    const response = await runMonitoredCron(
      new Request("https://example.test/api/cron/test", {
        headers: { "x-request-id": "unsafe request id" },
      }),
      "test-job",
      handler,
    );
    const body = await response.json();
    const log = JSON.parse(String(warningLog.mock.calls[0]?.[0]));

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(body.requestId).toBe(response.headers.get("x-request-id"));
    expect(body.requestId).not.toContain("unsafe request id");
    expect(log).toMatchObject({
      scope: "cron",
      requestId: body.requestId,
      jobName: "test-job",
      status: 401,
      outcome: "unauthorized",
    });
    expect(log.durationMs).toEqual(expect.any(Number));
  });
});
