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
      externalAlerts: {
        channel: "github_actions",
        configured: true,
        claimed: 0,
        delivered: 0,
        failed: 0,
      },
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
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
