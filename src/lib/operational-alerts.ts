import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type OperationalAlertNotification = {
  alert_key: string;
  category: string;
  severity: "warning" | "critical";
  event_type: "opened" | "updated" | "resolved";
  details: Record<string, unknown>;
  notification_version: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
};

type OperationalAlertRpcClient = {
  rpc(
    name: "claim_operational_alert_notifications",
    args: { p_limit: number; p_now: string },
  ): Promise<{
    data: OperationalAlertNotification[] | null;
    error: { message?: string } | null;
  }>;
  rpc(
    name: "complete_operational_alert_notification",
    args: {
      p_alert_key: string;
      p_error_message: string | null;
      p_notification_version: number;
      p_now: string;
      p_success: boolean;
    },
  ): Promise<{ data: null; error: { message?: string } | null }>;
};

type AlertDeliveryConfig =
  | {
      channel: "webhook";
      secret: string | null;
      url: string;
    }
  | {
      channel: "github_actions";
      ref: string;
      repository: string;
      token: string;
      workflow: string;
    };

export type OperationalAlertDeliverySummary = {
  channel: AlertDeliveryConfig["channel"] | null;
  configured: boolean;
  claimed: number;
  delivered: number;
  failed: number;
};

export async function deliverOperationalAlertNotifications({
  client = supabaseAdmin as unknown as OperationalAlertRpcClient,
  env = process.env,
  fetchImpl = fetch,
  now = new Date(),
}: {
  client?: OperationalAlertRpcClient;
  env?: Pick<NodeJS.ProcessEnv, string>;
  fetchImpl?: typeof fetch;
  now?: Date;
} = {}): Promise<OperationalAlertDeliverySummary> {
  const config = resolveOperationalAlertDeliveryConfig(env);
  if (!config) {
    logDelivery("warn", {
      channel: null,
      configured: false,
      message: "No external operational alert channel is configured.",
    });
    return { channel: null, configured: false, claimed: 0, delivered: 0, failed: 0 };
  }

  const timestamp = now.toISOString();
  const { data, error } = await client.rpc("claim_operational_alert_notifications", {
    p_limit: positiveInteger(env.OPERATIONS_ALERT_DELIVERY_LIMIT, 10, 20),
    p_now: timestamp,
  });
  if (error) throw new Error(error.message || "Unable to claim operational alerts.");

  const alerts = data ?? [];
  const outcomes = await Promise.all(
    alerts.map(async (alert) => {
      try {
        await dispatchOperationalAlert(config, alert, fetchImpl, env);
        await completeDelivery(client, alert, true, null, timestamp);
        logDelivery("info", {
          alertKey: alert.alert_key,
          channel: config.channel,
          event: alert.event_type,
          severity: alert.severity,
          status: "delivered",
        });
        return true;
      } catch (deliveryError) {
        const message =
          deliveryError instanceof Error ? deliveryError.message : String(deliveryError);
        await completeDelivery(client, alert, false, message, timestamp);
        logDelivery("error", {
          alertKey: alert.alert_key,
          channel: config.channel,
          event: alert.event_type,
          severity: alert.severity,
          status: "failed",
          message,
        });
        return false;
      }
    }),
  );

  const delivered = outcomes.filter(Boolean).length;
  return {
    channel: config.channel,
    configured: true,
    claimed: alerts.length,
    delivered,
    failed: alerts.length - delivered,
  };
}

export function resolveOperationalAlertDeliveryConfig(
  env: Pick<NodeJS.ProcessEnv, string>,
): AlertDeliveryConfig | null {
  const webhookUrl = firstFilledEnv(env.OPERATIONS_ALERT_WEBHOOK_URL);
  if (webhookUrl) {
    const url = new URL(webhookUrl);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("OPERATIONS_ALERT_WEBHOOK_URL must be an HTTPS URL without credentials.");
    }
    return {
      channel: "webhook",
      url: url.toString(),
      secret: firstFilledEnv(env.OPERATIONS_ALERT_WEBHOOK_SECRET) ?? null,
    };
  }

  const token = firstFilledEnv(
    env.GITHUB_SCROLL_TOKEN,
    env.IMMOJUDIS_GITHUB_ACTIONS_TOKEN,
    env.GITHUB_ACTIONS_DISPATCH_TOKEN,
  );
  if (!token) return null;

  const repository =
    firstFilledEnv(env.OPERATIONS_ALERT_GITHUB_REPOSITORY, env.GITHUB_SCROLL_REPOSITORY) ??
    "Aprivi-dev/immojudis";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Operational alert GitHub repository is invalid.");
  }

  return {
    channel: "github_actions",
    token,
    repository,
    workflow: firstFilledEnv(env.OPERATIONS_ALERT_GITHUB_WORKFLOW) ?? "operational-alert.yml",
    ref: firstFilledEnv(env.OPERATIONS_ALERT_GITHUB_REF, env.GITHUB_SCROLL_REF) ?? "main",
  };
}

async function dispatchOperationalAlert(
  config: AlertDeliveryConfig,
  alert: OperationalAlertNotification,
  fetchImpl: typeof fetch,
  env: Pick<NodeJS.ProcessEnv, string>,
): Promise<void> {
  const payload = operationalAlertPayload(alert, env);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response =
      config.channel === "webhook"
        ? await fetchImpl(config.url, {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              ...(config.secret ? { Authorization: `Bearer ${config.secret}` } : {}),
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
          })
        : await fetchImpl(
            `https://api.github.com/repos/${config.repository}/actions/workflows/${encodeURIComponent(config.workflow)}/dispatches`,
            {
              method: "POST",
              headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${config.token}`,
                "Content-Type": "application/json",
                "User-Agent": "immojudis-operational-alerts/1.0",
                "X-GitHub-Api-Version": "2022-11-28",
              },
              body: JSON.stringify({
                ref: config.ref,
                inputs: {
                  alert_key: payload.alertKey.slice(0, 100),
                  category: payload.category.slice(0, 40),
                  severity: payload.severity,
                  event_type: payload.event,
                  details: JSON.stringify(payload.details).slice(0, 8_000),
                  first_seen_at: payload.firstSeenAt,
                  last_seen_at: payload.lastSeenAt,
                  resolved_at: payload.resolvedAt ?? "",
                  environment: payload.environment.slice(0, 40),
                },
              }),
              signal: controller.signal,
            },
          );

    if (!response.ok) {
      throw new Error(`External alert endpoint returned HTTP ${response.status}.`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function operationalAlertPayload(
  alert: OperationalAlertNotification,
  env: Pick<NodeJS.ProcessEnv, string>,
) {
  return {
    service: "immojudis",
    environment: firstFilledEnv(env.VERCEL_ENV, env.NODE_ENV) ?? "unknown",
    alertKey: alert.alert_key,
    category: alert.category,
    severity: alert.severity,
    event: alert.event_type,
    details: alert.details,
    firstSeenAt: alert.first_seen_at,
    lastSeenAt: alert.last_seen_at,
    resolvedAt: alert.resolved_at,
    notificationVersion: alert.notification_version,
  };
}

async function completeDelivery(
  client: OperationalAlertRpcClient,
  alert: OperationalAlertNotification,
  success: boolean,
  errorMessage: string | null,
  timestamp: string,
) {
  const { error } = await client.rpc("complete_operational_alert_notification", {
    p_alert_key: alert.alert_key,
    p_error_message: errorMessage,
    p_notification_version: alert.notification_version,
    p_now: timestamp,
    p_success: success,
  });
  if (error) throw new Error(error.message || "Unable to complete operational alert delivery.");
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function firstFilledEnv(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}

function logDelivery(level: "info" | "warn" | "error", fields: Record<string, unknown>) {
  const line = JSON.stringify({
    scope: "operational-alert-delivery",
    timestamp: new Date().toISOString(),
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}
