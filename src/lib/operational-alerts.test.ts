import { describe, expect, it, vi } from "vitest";
import {
  buildOperationalAlertEmail,
  deliverOperationalAlertNotifications,
  resolveOperationalAlertDeliveryConfig,
  resolveOperationalAlertEmailConfig,
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

describe("operational alert email (second channel)", () => {
  const resend = { RESEND_API_KEY: "re_test_key", ALERT_EMAIL_FROM: "alertes@immojudis.test" };
  const github = { GITHUB_SCROLL_TOKEN: "github-token", VERCEL_ENV: "production" };
  const ok = () => new Response(JSON.stringify({ id: "email-1" }), { status: 200 });

  function routedFetch(routes: { github?: Response; resend?: Response }) {
    return vi.fn<typeof fetch>(async (input) => {
      if (new URL(String(input)).hostname === "api.resend.com") return routes.resend ?? ok();
      return routes.github ?? new Response(null, { status: 204 });
    });
  }
  const callsTo = (fetchImpl: ReturnType<typeof routedFetch>, host: string) =>
    fetchImpl.mock.calls.filter(([input]) => new URL(String(input)).hostname === host);

  it("sends nothing and says nothing without OPERATIONS_ALERT_EMAIL_TO", async () => {
    const fetchImpl = routedFetch({});
    const summary = await deliverOperationalAlertNotifications({
      client: rpcClient(),
      env: { ...github, ...resend },
      fetchImpl,
    });

    expect(callsTo(fetchImpl, "api.resend.com")).toHaveLength(0);
    expect(summary).toEqual({
      channel: "github_actions",
      configured: true,
      claimed: 1,
      delivered: 1,
      failed: 0,
    });
    expect(resolveOperationalAlertEmailConfig({ ...resend })).toBeNull();
  });

  it("emails the owner next to the GitHub dispatch, once per incident version", async () => {
    const fetchImpl = routedFetch({});
    const summary = await deliverOperationalAlertNotifications({
      client: rpcClient(),
      env: { ...github, ...resend, OPERATIONS_ALERT_EMAIL_TO: "owner@example.test" },
      fetchImpl,
    });

    expect(summary).toMatchObject({
      channel: "github_actions",
      delivered: 1,
      failed: 0,
      email: { sent: 1, failed: 0 },
    });
    expect(callsTo(fetchImpl, "api.github.com")).toHaveLength(1);
    const [[, request]] = callsTo(fetchImpl, "api.resend.com");
    const headers = request?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer re_test_key");
    expect(headers["idempotency-key"]).toBe("immojudis-ops-alert-cron.stale-2-owner@example.test");
    const payload = JSON.parse(String(request?.body));
    expect(payload).toMatchObject({
      from: "alertes@immojudis.test",
      to: ["owner@example.test"],
      subject: "[Immojudis] Incident ouvert · critical · cron.stale",
    });
    expect(payload.text).toContain("Catégorie : cron");
    expect(payload.text).toContain("stale_jobs");
    // Ni secret ni jeton dans le message.
    expect(JSON.stringify(payload)).not.toMatch(/re_test_key|github-token/);
  });

  it("never fails the incident because the email failed when the primary channel delivered", async () => {
    const client = rpcClient();
    const fetchImpl = routedFetch({ resend: new Response("{}", { status: 500 }) });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const summary = await deliverOperationalAlertNotifications({
      client,
      env: { ...github, ...resend, OPERATIONS_ALERT_EMAIL_TO: "owner@example.test" },
      fetchImpl,
    });

    expect(summary).toMatchObject({ delivered: 1, failed: 0, email: { sent: 0, failed: 1 } });
    expect(client.rpc).toHaveBeenLastCalledWith(
      "complete_operational_alert_notification",
      expect.objectContaining({ p_success: true }),
    );
  });

  it("still emails the owner when the GitHub dispatch fails, and the incident is retried", async () => {
    const client = rpcClient();
    const fetchImpl = routedFetch({ github: new Response(null, { status: 503 }) });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const summary = await deliverOperationalAlertNotifications({
      client,
      env: { ...github, ...resend, OPERATIONS_ALERT_EMAIL_TO: "owner@example.test" },
      fetchImpl,
    });

    expect(callsTo(fetchImpl, "api.resend.com")).toHaveLength(1);
    expect(summary).toMatchObject({ delivered: 0, failed: 1, email: { sent: 1, failed: 0 } });
    expect(client.rpc).toHaveBeenLastCalledWith(
      "complete_operational_alert_notification",
      expect.objectContaining({ p_success: false }),
    );
  });

  it("works alone when there is no GitHub token", async () => {
    const client = rpcClient();
    const fetchImpl = routedFetch({});

    const summary = await deliverOperationalAlertNotifications({
      client,
      env: { ...resend, OPERATIONS_ALERT_EMAIL_TO: "owner@example.test" },
      fetchImpl,
    });

    expect(summary).toMatchObject({ channel: "email", configured: true, delivered: 1, failed: 0 });
    expect(callsTo(fetchImpl, "api.github.com")).toHaveLength(0);
  });

  it("retries an email-only incident when the email fails", async () => {
    const client = rpcClient();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const summary = await deliverOperationalAlertNotifications({
      client,
      env: { ...resend, OPERATIONS_ALERT_EMAIL_TO: "owner@example.test" },
      fetchImpl: routedFetch({ resend: new Response("{}", { status: 422 }) }),
    });

    expect(summary).toMatchObject({ delivered: 0, failed: 1 });
    expect(client.rpc).toHaveBeenLastCalledWith(
      "complete_operational_alert_notification",
      expect.objectContaining({ p_success: false }),
    );
  });

  it("stays off, without claiming anything, when the address is there but Resend is not", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = rpcClient();

    expect(
      resolveOperationalAlertEmailConfig({ OPERATIONS_ALERT_EMAIL_TO: "owner@example.test" }),
    ).toBeNull();
    await expect(
      deliverOperationalAlertNotifications({
        client,
        env: { OPERATIONS_ALERT_EMAIL_TO: "owner@example.test" },
      }),
    ).resolves.toMatchObject({ configured: false, claimed: 0 });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("keeps only valid addresses, three at most", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      resolveOperationalAlertEmailConfig({
        ...resend,
        OPERATIONS_ALERT_EMAIL_TO:
          "a@example.test, not an address, b@example.test,c@example.test,d@example.test",
      })?.to,
    ).toEqual(["a@example.test", "b@example.test", "c@example.test"]);
    expect(
      resolveOperationalAlertEmailConfig({ ...resend, OPERATIONS_ALERT_EMAIL_TO: "nobody" }),
    ).toBeNull();
  });

  it("escapes the incident details in the HTML body", () => {
    const message = buildOperationalAlertEmail(
      { ...alert, details: { note: "<script>alert(1)</script>" }, resolved_at: null },
      "production",
      { from: "alertes@immojudis.test", to: "owner@example.test" },
    );

    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&lt;script&gt;");
    expect(message.subject).toBe("[Immojudis] Incident ouvert · critical · cron.stale");
    const resolved = buildOperationalAlertEmail(
      {
        ...alert,
        event_type: "resolved",
        severity: "warning",
        resolved_at: "2026-07-27T11:00:00.000Z",
      },
      "production",
      { from: "alertes@immojudis.test", to: "owner@example.test" },
    );
    expect(resolved.subject).toBe("[Immojudis] Incident résolu · warning · cron.stale");
    expect(resolved.text).toContain("Résolution : 2026-07-27T11:00:00.000Z");
  });
});
