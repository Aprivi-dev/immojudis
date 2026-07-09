import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { cleanSaleTitle } from "@/lib/sale-title";

type NotificationRow = Database["public"]["Tables"]["user_alert_notifications"]["Row"];

type ActiveEmailAlertDeliveryConfig = {
  apiKey: string;
  from: string;
  appUrl: string;
};

export type EmailAlertDeliveryConfig = {
  configured: boolean;
  apiKey: string | null;
  from: string | null;
  appUrl: string | null;
  missing: string[];
};

export type EmailAlertDeliveryOutcome = {
  notificationId: string;
  status: "sent" | "failed";
  recipient: string | null;
  messageId: string | null;
  detail: string | null;
};

export type EmailAlertDispatchSummary = {
  configured: boolean;
  candidateCount: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  outcomes: EmailAlertDeliveryOutcome[];
};

export type ResendEmailMessage = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  unsubscribeUrl?: string | null;
};

export type AlertEmailMessage = ResendEmailMessage & {
  unsubscribeUrl: string;
};

const notificationIdSchema = z.string().uuid();

export function resolveEmailAlertDeliveryConfig(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): EmailAlertDeliveryConfig {
  const apiKey = firstFilledEnv(env.RESEND_API_KEY);
  const from = firstFilledEnv(env.ALERT_EMAIL_FROM, env.RESEND_FROM_EMAIL);
  const appUrl = appOrigin(env);
  const missing = [
    ...(!apiKey ? ["RESEND_API_KEY"] : []),
    ...(!from ? ["ALERT_EMAIL_FROM"] : []),
    ...(!appUrl ? ["NEXT_PUBLIC_APP_URL"] : []),
  ];

  return {
    configured: missing.length === 0,
    apiKey: apiKey ?? null,
    from: from ?? null,
    appUrl,
    missing,
  };
}

export async function dispatchQueuedEmailAlertNotifications({
  notifications,
  now = new Date(),
  env = process.env,
  fetchImpl = fetch,
}: {
  notifications: NotificationRow[];
  now?: Date;
  env?: Pick<NodeJS.ProcessEnv, string>;
  fetchImpl?: typeof fetch;
}): Promise<EmailAlertDispatchSummary> {
  const config = resolveEmailAlertDeliveryConfig(env);
  if (!config.configured || !config.apiKey || !config.from || !config.appUrl) {
    return {
      configured: false,
      candidateCount: notifications.length,
      sentCount: 0,
      failedCount: 0,
      skippedCount: notifications.length,
      outcomes: [],
    };
  }

  const activeConfig: ActiveEmailAlertDeliveryConfig = {
    apiKey: config.apiKey,
    from: config.from,
    appUrl: config.appUrl,
  };

  const outcomes: EmailAlertDeliveryOutcome[] = [];
  for (const notification of notifications) {
    outcomes.push(
      await deliverEmailAlertNotification({
        notification,
        config: activeConfig,
        now,
        fetchImpl,
      }),
    );
  }

  return {
    configured: true,
    candidateCount: notifications.length,
    sentCount: outcomes.filter((outcome) => outcome.status === "sent").length,
    failedCount: outcomes.filter((outcome) => outcome.status === "failed").length,
    skippedCount: 0,
    outcomes,
  };
}

export async function unsubscribeEmailAlertsByNotificationId({
  notificationId,
  now = new Date(),
}: {
  notificationId: string;
  now?: Date;
}): Promise<{ userId: string; revokedAt: string }> {
  const parsedNotificationId = notificationIdSchema.parse(notificationId);
  const { data: notification, error: notificationError } = await supabaseAdmin
    .from("user_alert_notifications")
    .select("id,user_id,delivery_channel")
    .eq("id", parsedNotificationId)
    .eq("delivery_channel", "email")
    .maybeSingle();

  if (notificationError) throw notificationError;
  if (!notification) throw new Error("Lien de désinscription invalide ou expiré.");

  const revokedAt = now.toISOString();
  const { error } = await supabaseAdmin.from("user_notification_preferences").upsert(
    {
      user_id: notification.user_id,
      alert_email_enabled: false,
      alert_email_revoked_at: revokedAt,
      consent_source: "settings",
    },
    { onConflict: "user_id" },
  );

  if (error) throw error;
  return { userId: notification.user_id, revokedAt };
}

export function buildAlertEmailMessage({
  notification,
  recipientEmail,
  from,
  appUrl,
}: {
  notification: Pick<NotificationRow, "id" | "notification_snapshot">;
  recipientEmail: string;
  from: string;
  appUrl: string;
}): AlertEmailMessage {
  const snapshot = asRecord(notification.notification_snapshot);
  const alert = asRecord(snapshot.alert);
  const sale = asRecord(snapshot.sale);
  const match = asRecord(snapshot.match);
  const title = cleanSaleTitle(stringValue(sale.title)) ?? "Vente judiciaire";
  const city = stringValue(sale.city);
  const department = stringValue(sale.department);
  const location = [city, department].filter(Boolean).join(" · ");
  const alertName = stringValue(alert.name) ?? "Alerte ImmoJudis";
  const reasons = arrayOfStrings(match.reasons).slice(0, 4);
  const marketDiscountPct = numberValue(match.marketDiscountPct);
  const saleUrl = `${appUrl}/sales/${encodeURIComponent(stringValue(sale.id) ?? "")}`;
  const unsubscribeUrl = `${appUrl}/api/notification-preferences/unsubscribe?notificationId=${encodeURIComponent(notification.id)}`;
  const subject = `Alerte ImmoJudis - ${title}${city ? ` à ${city}` : ""}`;
  const discountLine =
    marketDiscountPct == null
      ? null
      : `Décote estimée: ${Math.round(marketDiscountPct)} % par rapport aux comparables disponibles.`;

  const textLines = [
    `${alertName}`,
    "",
    `${title}${location ? ` - ${location}` : ""}`,
    discountLine,
    reasons.length ? `Critères détectés: ${reasons.join(", ")}` : null,
    "",
    `Consulter l'annonce: ${saleUrl}`,
    "",
    "Les données et estimations ImmoJudis sont indicatives. Elles ne constituent ni une expertise, ni un conseil juridique ou financier, ni une promesse de gain.",
    `Se désinscrire des alertes email: ${unsubscribeUrl}`,
  ].filter((line): line is string => typeof line === "string");

  return {
    from,
    to: recipientEmail,
    subject,
    text: textLines.join("\n"),
    html: buildAlertEmailHtml({
      alertName,
      title,
      location,
      reasons,
      discountLine,
      saleUrl,
      unsubscribeUrl,
    }),
    unsubscribeUrl,
  };
}

async function deliverEmailAlertNotification({
  notification,
  config,
  now,
  fetchImpl,
}: {
  notification: NotificationRow;
  config: ActiveEmailAlertDeliveryConfig;
  now: Date;
  fetchImpl: typeof fetch;
}): Promise<EmailAlertDeliveryOutcome> {
  const recipient = await readUserEmail(notification.user_id);
  if (!recipient) {
    const detail = "Aucune adresse email authentifiée disponible pour cet utilisateur.";
    await markEmailNotificationFailed({ notification, now, detail, recipient: null });
    return {
      notificationId: notification.id,
      status: "failed",
      recipient: null,
      messageId: null,
      detail,
    };
  }

  const message = buildAlertEmailMessage({
    notification,
    recipientEmail: recipient,
    from: config.from,
    appUrl: config.appUrl,
  });

  try {
    const sendResult = await sendResendEmail({
      apiKey: config.apiKey,
      message,
      idempotencyKey: `immojudis-alert-${notification.id}`,
      fetchImpl,
    });
    await markEmailNotificationSent({
      notification,
      now,
      recipient,
      messageId: sendResult.id,
    });
    return {
      notificationId: notification.id,
      status: "sent",
      recipient,
      messageId: sendResult.id,
      detail: null,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Envoi email impossible.";
    await markEmailNotificationFailed({ notification, now, detail, recipient });
    return {
      notificationId: notification.id,
      status: "failed",
      recipient,
      messageId: null,
      detail,
    };
  }
}

export async function sendResendEmail({
  apiKey,
  message,
  idempotencyKey,
  fetchImpl,
}: {
  apiKey: string;
  message: ResendEmailMessage;
  idempotencyKey: string;
  fetchImpl: typeof fetch;
}): Promise<{ id: string | null }> {
  const payload: Record<string, unknown> = {
    from: message.from,
    to: [message.to],
    subject: message.subject,
    html: message.html,
    text: message.text,
  };
  if (message.unsubscribeUrl) {
    payload.headers = {
      "List-Unsubscribe": `<${message.unsubscribeUrl}>`,
    };
  }

  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
  const body = await readResendBody(response);

  if (!response.ok) {
    throw new Error(body.error ?? `Resend a refusé l'envoi (${response.status}).`);
  }

  return { id: body.id ?? null };
}

async function readUserEmail(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error) throw error;
  const email = data.user?.email?.trim();
  return email || null;
}

async function markEmailNotificationSent({
  notification,
  now,
  recipient,
  messageId,
}: {
  notification: NotificationRow;
  now: Date;
  recipient: string;
  messageId: string | null;
}) {
  const sentAt = now.toISOString();
  const { error } = await supabaseAdmin
    .from("user_alert_notifications")
    .update({
      delivery_status: "sent",
      sent_at: sentAt,
      updated_at: sentAt,
      notification_snapshot: withEmailDeliverySnapshot(notification.notification_snapshot, {
        status: "sent",
        provider: "resend",
        messageId,
        recipient,
        sentAt,
      }),
    })
    .eq("id", notification.id)
    .eq("delivery_channel", "email")
    .eq("delivery_status", "queued");

  if (error) throw error;
}

async function markEmailNotificationFailed({
  notification,
  now,
  detail,
  recipient,
}: {
  notification: NotificationRow;
  now: Date;
  detail: string;
  recipient: string | null;
}) {
  const failedAt = now.toISOString();
  const { error } = await supabaseAdmin
    .from("user_alert_notifications")
    .update({
      delivery_status: "failed",
      updated_at: failedAt,
      notification_snapshot: withEmailDeliverySnapshot(notification.notification_snapshot, {
        status: "failed",
        provider: "resend",
        recipient,
        failedAt,
        error: detail,
      }),
    })
    .eq("id", notification.id)
    .eq("delivery_channel", "email")
    .eq("delivery_status", "queued");

  if (error) throw error;
}

function withEmailDeliverySnapshot(snapshot: Json, delivery: Record<string, unknown>): Json {
  return {
    ...asRecord(snapshot),
    emailDelivery: delivery,
  } as Json;
}

async function readResendBody(response: Response): Promise<{ id?: string; error?: string }> {
  const text = await response.text();
  if (!text.trim()) return {};

  try {
    const data = JSON.parse(text) as { id?: unknown; error?: unknown; message?: unknown };
    return {
      id: typeof data.id === "string" ? data.id : undefined,
      error:
        typeof data.error === "string"
          ? data.error
          : typeof data.message === "string"
            ? data.message
            : undefined,
    };
  } catch {
    return { error: text.slice(0, 280) };
  }
}

function buildAlertEmailHtml({
  alertName,
  title,
  location,
  reasons,
  discountLine,
  saleUrl,
  unsubscribeUrl,
}: {
  alertName: string;
  title: string;
  location: string;
  reasons: string[];
  discountLine: string | null;
  saleUrl: string;
  unsubscribeUrl: string;
}): string {
  const reasonItems = reasons
    .map((reason) => `<li style="margin: 0 0 6px;">${escapeHtml(reason)}</li>`)
    .join("");

  return `<!doctype html>
<html>
  <body style="margin:0;background:#f6f4ef;color:#182033;font-family:Arial,sans-serif;">
    <div style="max-width:620px;margin:0 auto;padding:28px 18px;">
      <div style="background:#fff;border:1px solid #e8e1d4;border-radius:10px;padding:24px;">
        <p style="margin:0 0 10px;color:#9b7a2f;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">${escapeHtml(alertName)}</p>
        <h1 style="margin:0 0 8px;font-size:22px;line-height:1.25;color:#182033;">${escapeHtml(title)}</h1>
        ${location ? `<p style="margin:0 0 18px;color:#6c7280;">${escapeHtml(location)}</p>` : ""}
        ${discountLine ? `<p style="margin:0 0 16px;font-weight:700;color:#182033;">${escapeHtml(discountLine)}</p>` : ""}
        ${
          reasonItems
            ? `<ul style="margin:0 0 20px;padding-left:18px;color:#4b5563;">${reasonItems}</ul>`
            : ""
        }
        <a href="${escapeAttribute(saleUrl)}" style="display:inline-block;background:#182033;color:#fff;text-decoration:none;border-radius:8px;padding:12px 16px;font-weight:700;">Voir l'annonce</a>
        <p style="margin:22px 0 0;color:#6c7280;font-size:12px;line-height:1.5;">
          Les données et estimations ImmoJudis sont indicatives. Elles ne constituent ni une expertise, ni un conseil juridique ou financier, ni une promesse de gain.
        </p>
      </div>
      <p style="margin:14px 0 0;text-align:center;color:#7b8190;font-size:12px;">
        <a href="${escapeAttribute(unsubscribeUrl)}" style="color:#7b8190;">Se désinscrire des alertes email</a>
      </p>
    </div>
  </body>
</html>`;
}

function appOrigin(env: Pick<NodeJS.ProcessEnv, string>): string | null {
  const rawOrigin =
    env.NEXT_PUBLIC_APP_URL || env.APP_URL || env.NEXT_PUBLIC_SITE_URL || env.VERCEL_URL;
  if (!rawOrigin) return null;
  const origin = /^https?:\/\//i.test(rawOrigin) ? rawOrigin : `https://${rawOrigin}`;
  return origin.replace(/\/+$/, "");
}

function firstFilledEnv(...values: Array<string | undefined>) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
