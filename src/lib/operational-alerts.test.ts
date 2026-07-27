import { describe, expect, it, vi } from "vitest";
import {
  deliverOperationalAlertNotifications,
  resolveOperationalAlertDeliveryConfig,
  type OperationalAlertNotification,
} from "@/lib/operational-alerts";

const alert: OperationalAlertNotification = {
  alert_key: "cron.stale",
  category: "cron",
  severity: "critical",
  event_type: "opened",
  details: { stale_jobs: ["sale-change-monitor"] },
  notification_version: 2,
  first_seen_at: "2026-07-27T10:00:00.000Z",
  last_seen_at: "2026-07-27T10:15:00.000Z",
  resolved_at: null,
};

function rpcClient(alerts: OperationalAlertNotification[] = [alert]) {
  const rpc = vi
    .fn()
    .mockResolvedValueOnce({ data: alerts, error: null })
    .mockResolvedValue({ data: null, error: null });
  return { rpc };
}

describe("operational alert delivery", () => {
  it("uses the existing GitHub Actions token as an external alert channel", () => {
    expect(
      resolveOperationalAlertDeliveryConfig({ GITHUB_SCROLL_TOKEN: "github-token" }),
    ).toMatchObject({
      channel: "github_actions",
      repository: "Aprivi-dev/immojudis",
      workflow: "operational-alert.yml",
      ref: "main",
    });
  });

  it("prefers a configured HTTPS webhook", () => {
    expect(
      resolveOperationalAlertDeliveryConfig({
        OPERATIONS_ALERT_WEBHOOK_URL: "https://alerts.example.test/immojudis",
        OPERATIONS_ALERT_WEBHOOK_SECRET: "secret",
        GITHUB_SCROLL_TOKEN: "github-token",
      }),
    ).toMatchObject({
      channel: "webhook",
      url: "https://alerts.example.test/immojudis",
      secret: "secret",
    });
  });

  it("rejects an insecure webhook before claiming alerts", async () => {
    const client = rpcClient();
    await expect(
      deliverOperationalAlertNotifications({
        client,
        env: { OPERATIONS_ALERT_WEBHOOK_URL: "http://alerts.example.test/immojudis" },
      }),
    ).rejects.toThrow("must be an HTTPS URL");
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("dispatches and acknowledges a GitHub Actions alert", async () => {
    const client = rpcClient();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      deliverOperationalAlertNotifications({
        client,
        env: {
          GITHUB_SCROLL_TOKEN: "github-token",
          VERCEL_ENV: "production",
        },
        fetchImpl,
        now: new Date("2026-07-27T10:20:00.000Z"),
      }),
    ).resolves.toEqual({
      channel: "github_actions",
      configured: true,
      claimed: 1,
      delivered: 1,
      failed: 0,
    });

    const [, request] = fetchImpl.mock.calls[0];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      ref: "main",
      inputs: {
        alert_key: "cron.stale",
        event_type: "opened",
        severity: "critical",
      },
    });
    expect(client.rpc).toHaveBeenLastCalledWith(
      "complete_operational_alert_notification",
      expect.objectContaining({
        p_alert_key: "cron.stale",
        p_notification_version: 2,
        p_success: true,
      }),
    );
  });

  it("records a retryable failure when the external endpoint rejects delivery", async () => {
    const client = rpcClient();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));

    await expect(
      deliverOperationalAlertNotifications({
        client,
        env: { GITHUB_SCROLL_TOKEN: "github-token" },
        fetchImpl,
      }),
    ).resolves.toMatchObject({ delivered: 0, failed: 1 });
    expect(client.rpc).toHaveBeenLastCalledWith(
      "complete_operational_alert_notification",
      expect.objectContaining({
        p_success: false,
        p_error_message: "External alert endpoint returned HTTP 503.",
      }),
    );
  });

  it("does not claim alerts when no external channel is configured", async () => {
    const client = rpcClient();
    await expect(deliverOperationalAlertNotifications({ client, env: {} })).resolves.toMatchObject({
      configured: false,
      claimed: 0,
    });
    expect(client.rpc).not.toHaveBeenCalled();
  });
});
