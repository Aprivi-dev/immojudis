import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendResendEmail } from "@/lib/email-alerts";
import { serverEnv } from "@/lib/env";
import { escapeHtml } from "@/lib/guards";

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

/** Second channel: an email to the owner, through Resend. Present only when OPERATIONS_ALERT_EMAIL_TO is set. */
type AlertEmailConfig = {
  apiKey: string;
  from: string;
  to: string[];
};

export type OperationalAlertDeliverySummary = {
  /** The primary channel (webhook or GitHub Actions); `email` when it is the only one configured. */
  channel: AlertDeliveryConfig["channel"] | "email" | null;
  configured: boolean;
  claimed: number;
  delivered: number;
  failed: number;
  /** Only when the email channel is on: how many incident emails left, how many did not. */
  email?: { sent: number; failed: number };
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
  const emailConfig = resolveOperationalAlertEmailConfig(env);
  if (!config && !emailConfig) {
    logDelivery("warn", {
      channel: null,
      configured: false,
      message: "No external operational alert channel is configured.",
    });
    return { channel: null, configured: false, claimed: 0, delivered: 0, failed: 0 };
  }
  const channel = config?.channel ?? "email";

  const timestamp = now.toISOString();
  const { data, error } = await client.rpc("claim_operational_alert_notifications", {
    p_limit: positiveInteger(env.OPERATIONS_ALERT_DELIVERY_LIMIT, 10, 20),
    p_now: timestamp,
  });
  if (error) throw new Error(error.message || "Unable to claim operational alerts.");

  const alerts = data ?? [];
  let emailSent = 0;
  let emailFailed = 0;
  const outcomes = await Promise.all(
    alerts.map(async (alert) => {
      // Both channels are tried, whatever the other does: the email is there for the day the primary one is
      // down. The notification succeeds on the primary channel when there is one (a failed email is logged
      // and never retried through it); the email alone decides when it is the only channel.
      const [primary, emailResult] = await Promise.allSettled([
        config ? dispatchOperationalAlert(config, alert, fetchImpl, env) : Promise.resolve(),
        emailConfig
          ? sendOperationalAlertEmail(emailConfig, alert, fetchImpl, env)
          : Promise.resolve(),
      ]);
      if (emailConfig) {
        if (emailResult.status === "fulfilled") emailSent += 1;
        else {
          emailFailed += 1;
          logDelivery("error", {
            alertKey: alert.alert_key,
            channel: "email",
            event: alert.event_type,
            severity: alert.severity,
            status: "failed",
            message: errorMessage(emailResult.reason),
          });
        }
      }
      const decisive = config ? primary : emailResult;
      try {
        if (decisive.status === "rejected") throw decisive.reason;
        await completeDelivery(client, alert, true, null, timestamp);
        logDelivery("info", {
          alertKey: alert.alert_key,
          channel,
          event: alert.event_type,
          severity: alert.severity,
          status: "delivered",
        });
        return true;
      } catch (deliveryError) {
        const message = errorMessage(deliveryError);
        await completeDelivery(client, alert, false, message, timestamp);
        logDelivery("error", {
          alertKey: alert.alert_key,
          channel,
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
    channel,
    configured: true,
    claimed: alerts.length,
    delivered,
    failed: alerts.length - delivered,
    ...(emailConfig ? { email: { sent: emailSent, failed: emailFailed } } : {}),
  };
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * The email channel: on only when OPERATIONS_ALERT_EMAIL_TO lists at least one valid address AND Resend is
 * configured (RESEND_API_KEY and ALERT_EMAIL_FROM, already used by the alert emails). No new secret.
 * Without the variable, nothing is sent and nothing is logged: the channel does not exist.
 */
export function resolveOperationalAlertEmailConfig(
  env: Pick<NodeJS.ProcessEnv, string>,
): AlertEmailConfig | null {
  const { alerts, email } = serverEnv(env);
  if (!alerts.emailTo) return null;
  const to = alerts.emailTo
    .split(",")
    .map((address) => address.trim())
    .filter((address) => /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(address))
    .slice(0, 3);
  if (to.length === 0 || !email.resendApiKey || !email.from) {
    logDelivery("warn", {
      channel: "email",
      configured: false,
      message:
        "OPERATIONS_ALERT_EMAIL_TO is set but the email channel is off: it needs a valid address, RESEND_API_KEY and ALERT_EMAIL_FROM.",
    });
    return null;
  }
  return { apiKey: email.resendApiKey, from: email.from, to };
}

const EVENT_LABELS: Record<OperationalAlertNotification["event_type"], string> = {
  opened: "Incident ouvert",
  updated: "Incident toujours ouvert",
  resolved: "Incident résolu",
};

/** The incident email: the same bounded facts as the GitHub payload (no secret, no user data). */
export function buildOperationalAlertEmail(
  alert: OperationalAlertNotification,
  environment: string,
  { from, to }: Pick<AlertEmailConfig, "from"> & { to: string },
) {
  const label = EVENT_LABELS[alert.event_type];
  const details = JSON.stringify(alert.details, null, 2).slice(0, 4_000);
  const lines = [
    `${label} (${alert.severity}) : ${alert.alert_key}`,
    "",
    `Catégorie : ${alert.category}`,
    `Environnement : ${environment}`,
    `Première occurrence : ${alert.first_seen_at}`,
    `Dernière occurrence : ${alert.last_seen_at}`,
    ...(alert.resolved_at ? [`Résolution : ${alert.resolved_at}`] : []),
    "",
    "Diagnostic :",
    details,
    "",
    "Cet email double l'alerte du workflow GitHub « Immojudis Operational Alert ».",
  ];
  return {
    from,
    to,
    subject: `[Immojudis] ${label} · ${alert.severity} · ${alert.alert_key}`.slice(0, 200),
    text: lines.join("\n"),
    html: `<p><strong>${escapeHtml(label)}</strong> (${escapeHtml(alert.severity)}) : <code>${escapeHtml(alert.alert_key)}</code></p><ul><li>Catégorie : ${escapeHtml(alert.category)}</li><li>Environnement : ${escapeHtml(environment)}</li><li>Première occurrence : ${escapeHtml(alert.first_seen_at)}</li><li>Dernière occurrence : ${escapeHtml(alert.last_seen_at)}</li>${alert.resolved_at ? `<li>Résolution : ${escapeHtml(alert.resolved_at)}</li>` : ""}</ul><p>Diagnostic :</p><pre>${escapeHtml(details)}</pre><p>Cet email double l'alerte du workflow GitHub « Immojudis Operational Alert ».</p>`,
  };
}

async function sendOperationalAlertEmail(
  config: AlertEmailConfig,
  alert: OperationalAlertNotification,
  fetchImpl: typeof fetch,
  env: Pick<NodeJS.ProcessEnv, string>,
): Promise<void> {
  const environment = serverEnv(env).alerts.environment;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    for (const to of config.to) {
      await sendResendEmail({
        apiKey: config.apiKey,
        // Resend ignores a repeated key for 24 hours: a retried notification does not send the email twice.
        idempotencyKey:
          `immojudis-ops-alert-${alert.alert_key}-${alert.notification_version}-${to}`.slice(
            0,
            256,
          ),
        fetchImpl: (input, init) => fetchImpl(input, { ...init, signal: controller.signal }),
        message: buildOperationalAlertEmail(alert, environment, { from: config.from, to }),
        category: "operations",
      });
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function resolveOperationalAlertDeliveryConfig(
  env: Pick<NodeJS.ProcessEnv, string>,
): AlertDeliveryConfig | null {
  const { alerts, pipeline } = serverEnv(env);
  const webhookUrl = alerts.webhookUrl;
  if (webhookUrl) {
    const url = new URL(webhookUrl);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("OPERATIONS_ALERT_WEBHOOK_URL must be an HTTPS URL without credentials.");
    }
    return {
      channel: "webhook",
      url: url.toString(),
      secret: alerts.webhookSecret ?? null,
    };
  }

  const token = pipeline.githubToken;
  if (!token) return null;

  const repository = alerts.githubRepository;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Operational alert GitHub repository is invalid.");
  }

  return {
    channel: "github_actions",
    token,
    repository,
    workflow: alerts.githubWorkflow,
    ref: alerts.githubRef,
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
    environment: serverEnv(env).alerts.environment,
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
