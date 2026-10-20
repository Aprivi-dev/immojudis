import "server-only";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { createHash } from "node:crypto";
import { serverEnv } from "@/lib/env";
import { emailClickUrl, isEmailClickSaleId } from "@/lib/email-click-token";
import { createUnsubscribeToken } from "@/lib/email-unsubscribe-token";
import { canCreateEmailAlertNotification } from "@/lib/notification-preferences";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import { cleanSaleTitle } from "@/lib/sale-title";
import { resolveSiteOrigin } from "@/lib/site-url";
import { systemAuthForUser } from "@/lib/system-auth";
import { asRecord, escapeHtml, numberValue, stringValue } from "@/lib/guards";

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
  replyTo?: string | null;
  subject: string;
  html: string;
  text: string;
  unsubscribeUrl?: string | null;
  /** Advertise RFC 8058 one-click unsubscribe (the URL must accept a POST). */
  oneClickUnsubscribe?: boolean;
};

export type AlertEmailMessage = ResendEmailMessage & {
  unsubscribeUrl: string;
};

const notificationIdSchema = z.string().uuid();

export function resolveEmailAlertDeliveryConfig(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): EmailAlertDeliveryConfig {
  const { resendApiKey: apiKey, from } = serverEnv(env).email;
  const appUrl = resolveSiteOrigin(env);
  const missing = [
    ...(!apiKey ? ["RESEND_API_KEY"] : []),
    ...(!from ? ["ALERT_EMAIL_FROM"] : []),
    ...(!appUrl ? ["SITE_URL"] : []),
  ];

  return {
    configured: missing.length === 0,
    apiKey: apiKey ?? null,
    from: from ?? null,
    appUrl,
    missing,
  };
}

const MAX_DIGEST_ITEMS = 10;

type DigestItem = {
  notificationId: string;
  alertId: string | null;
  alertName: string;
  saleId: string | null;
  title: string;
  location: string;
  reasons: string[];
  discountLine: string | null;
  /** Hearing date, formatted for the email, when the snapshot carries one. */
  hearingDate: string | null;
  /** Starting price (mise à prix), formatted for the email, when known. */
  startingPrice: string | null;
};

const hearingDateFormat = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Europe/Paris",
});

const priceFormat = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

function formatHearingDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : hearingDateFormat.format(date);
}

function formatStartingPrice(value: number | null): string | null {
  return value == null || !Number.isFinite(value) || value <= 0 ? null : priceFormat.format(value);
}

/** « Audience : 12 novembre 2026 · Mise à prix : 95 000 € », or null when neither is known. */
function saleFactsLine(item: Pick<DigestItem, "hearingDate" | "startingPrice">): string | null {
  const parts = [
    item.hearingDate ? `Audience : ${item.hearingDate}` : null,
    item.startingPrice ? `Mise à prix : ${item.startingPrice}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(" · ") : null;
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

  // One email per user and run, however many sales matched.
  const byUser = new Map<string, NotificationRow[]>();
  for (const notification of notifications) {
    byUser.set(notification.user_id, [...(byUser.get(notification.user_id) ?? []), notification]);
  }

  const outcomes: EmailAlertDeliveryOutcome[] = [];
  let skippedCount = 0;
  for (const [userId, userNotifications] of byUser) {
    const result = await deliverEmailAlertDigest({
      userId,
      notifications: userNotifications,
      config: activeConfig,
      now,
      fetchImpl,
      env,
    });
    skippedCount += result.skipped;
    outcomes.push(...result.outcomes);
  }

  return {
    configured: true,
    candidateCount: notifications.length,
    sentCount: outcomes.filter((outcome) => outcome.status === "sent").length,
    failedCount: outcomes.filter((outcome) => outcome.status === "failed").length,
    skippedCount,
    outcomes,
  };
}

/** Switch email alerts off for a user (global unsubscribe). */
export async function revokeEmailAlertConsent({
  userId,
  now = new Date(),
}: {
  userId: string;
  now?: Date;
}): Promise<{ userId: string; revokedAt: string }> {
  const revokedAt = now.toISOString();
  const { error } = await supabaseAdmin.from("user_notification_preferences").upsert(
    {
      user_id: userId,
      alert_email_enabled: false,
      alert_email_revoked_at: revokedAt,
      consent_source: "settings",
    },
    { onConflict: "user_id" },
  );
  if (error) throw error;
  await cancelQueuedEmailNotifications({ userId, now, reason: "unsubscribed" });
  return { userId, revokedAt };
}

/**
 * Retire le consentement aux rappels d'audience et avertissements graves (désinscription par le
 * lien signé de chaque email). Le consentement aux alertes email n'est pas touché.
 */
export async function revokeSaleReminderConsent({
  userId,
  now = new Date(),
}: {
  userId: string;
  now?: Date;
}): Promise<{ userId: string; revokedAt: string }> {
  const revokedAt = now.toISOString();
  const { error } = await supabaseAdmin.from("user_notification_preferences").upsert(
    {
      user_id: userId,
      sale_reminders_enabled: false,
      sale_reminders_revoked_at: revokedAt,
    },
    { onConflict: "user_id" },
  );
  if (error) throw error;
  return { userId, revokedAt };
}

/** Pause a single alert (per-alert unsubscribe); other alerts keep running. */
export async function deactivateAlertForUser({
  userId,
  alertId,
  now = new Date(),
}: {
  userId: string;
  alertId: string;
  now?: Date;
}): Promise<void> {
  const { error } = await supabaseAdmin
    .from("user_alerts")
    .update({ is_active: false })
    .eq("id", alertId)
    .eq("user_id", userId);
  if (error) throw error;
  await cancelQueuedEmailNotifications({ userId, alertId, now, reason: "alert_paused" });
}

/** Legacy links carried a notification id; they now only resolve to a user. */
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
  return revokeEmailAlertConsent({ userId: notification.user_id, now });
}

async function cancelQueuedEmailNotifications({
  userId,
  alertId,
  now,
  reason,
}: {
  userId: string;
  alertId?: string;
  now: Date;
  reason: string;
}) {
  const at = now.toISOString();
  let query = supabaseAdmin
    .from("user_alert_notifications")
    .update({ delivery_status: "cancelled", updated_at: at })
    .eq("user_id", userId)
    .eq("delivery_channel", "email")
    .eq("delivery_status", "queued");
  if (alertId) query = query.eq("alert_id", alertId);
  const { error } = await query;
  if (error) throw new Error(`Annulation des emails en attente impossible (${reason}).`);
}

function digestItemFromNotification(notification: NotificationRow): DigestItem {
  const snapshot = asRecord(notification.notification_snapshot);
  const alert = asRecord(snapshot.alert);
  const sale = asRecord(snapshot.sale);
  const match = asRecord(snapshot.match);
  const city = stringValue(sale.city);
  const department = stringValue(sale.department);
  const marketDiscountPct = numberValue(match.marketDiscountPct);
  return {
    notificationId: notification.id,
    alertId: stringValue(alert.id) ?? notification.alert_id ?? null,
    alertName: stringValue(alert.name) ?? "Alerte Immojudis",
    saleId: stringValue(sale.id) ?? notification.sale_id ?? null,
    title: cleanSaleTitle(stringValue(sale.title)) ?? "Vente judiciaire",
    location: [city, department].filter(Boolean).join(" · "),
    reasons: arrayOfStrings(match.reasons).slice(0, 4),
    discountLine:
      marketDiscountPct == null
        ? null
        : `Mise à prix inférieure d’environ ${Math.round(marketDiscountPct)} % à la référence DVF (indicatif : hors frais, travaux et occupation).`,
    hearingDate: formatHearingDate(stringValue(sale.saleDate)),
    startingPrice: formatStartingPrice(numberValue(sale.startingPriceEur)),
  };
}

/**
 * Build the single digest email of a user. Unsubscribe links are signed
 * tokens and the global one is also the RFC 8058 one-click target.
 */
export function buildAlertDigestMessage({
  userId,
  notifications,
  recipientEmail,
  from,
  appUrl,
  now = new Date(),
  env,
}: {
  userId: string;
  notifications: Array<
    Pick<NotificationRow, "id" | "notification_snapshot"> &
      Partial<Pick<NotificationRow, "alert_id" | "sale_id">>
  >;
  recipientEmail: string;
  from: string;
  appUrl: string;
  now?: Date;
  env?: Pick<NodeJS.ProcessEnv, string>;
}): AlertEmailMessage {
  const allItems = notifications.map((notification) =>
    digestItemFromNotification(notification as NotificationRow),
  );
  const items = allItems.slice(0, MAX_DIGEST_ITEMS);
  const hiddenCount = allItems.length - items.length;
  const tokenUrl = (scope?: { alertId: string }) =>
    `${appUrl}/api/notification-preferences/unsubscribe?token=${encodeURIComponent(
      createUnsubscribeToken({
        userId,
        scope: scope ? { kind: "alert", alertId: scope.alertId } : { kind: "alerts" },
        now,
        env,
      }),
    )}`;
  const unsubscribeUrl = tokenUrl();
  const alertsUrl = `${appUrl}/alertes`;

  const groups = new Map<
    string,
    { alertId: string | null; alertName: string; items: DigestItem[] }
  >();
  for (const item of items) {
    const key = item.alertId ?? item.alertName;
    const group = groups.get(key) ?? {
      alertId: item.alertId,
      alertName: item.alertName,
      items: [],
    };
    group.items.push(item);
    groups.set(key, group);
  }

  const subject =
    allItems.length === 1
      ? `Alerte Immojudis — ${items[0].title}${items[0].location ? ` (${items[0].location})` : ""}${
          items[0].hearingDate ? `, audience le ${items[0].hearingDate}` : ""
        }`
      : `Alerte Immojudis — ${allItems.length} ventes correspondent à vos alertes`;

  // Lien suivi (point 65) : redirection signée qui mesure le clic pour ce compte, puis mène à la
  // fiche de la vente. Sans identifiant de vente valide, le lien reste direct.
  const saleUrl = (item: DigestItem) =>
    isEmailClickSaleId(item.saleId)
      ? emailClickUrl({
          appUrl,
          userId,
          kind: "alert",
          target: "sale",
          saleId: item.saleId,
          now,
          env,
        })
      : `${appUrl}/sales/${encodeURIComponent(item.saleId ?? "")}`;
  const disclaimer =
    "Les données et estimations Immojudis sont indicatives. Elles ne constituent ni une expertise, ni un conseil juridique ou financier, ni une promesse de gain.";

  const intro =
    allItems.length === 1
      ? "Une vente correspond à l’une de vos alertes Immojudis :"
      : "Voici les ventes qui correspondent à vos alertes Immojudis :";
  const textLines: string[] = ["Bonjour,", "", intro, ""];
  for (const group of groups.values()) {
    textLines.push(group.alertName, "");
    for (const item of group.items) {
      textLines.push(`- ${item.title}${item.location ? ` - ${item.location}` : ""}`);
      const facts = saleFactsLine(item);
      if (facts) textLines.push(`  ${facts}`);
      if (item.discountLine) textLines.push(`  ${item.discountLine}`);
      if (item.reasons.length) textLines.push(`  Critères détectés : ${item.reasons.join(", ")}`);
      textLines.push(`  Consulter l'annonce : ${saleUrl(item)}`);
    }
    if (group.alertId) {
      textLines.push("", `Désactiver cette alerte : ${tokenUrl({ alertId: group.alertId })}`);
    }
    textLines.push("");
  }
  if (hiddenCount > 0) {
    textLines.push(
      `… et ${hiddenCount} autre${hiddenCount > 1 ? "s" : ""} vente${hiddenCount > 1 ? "s" : ""} : ${alertsUrl}`,
      "",
    );
  }
  textLines.push(
    disclaimer,
    "",
    `Se désinscrire de tous les emails d'alerte : ${unsubscribeUrl}`,
    `Gérer mes alertes : ${alertsUrl}`,
  );

  return {
    from,
    to: recipientEmail,
    subject,
    text: textLines.join("\n"),
    html: buildAlertDigestHtml({
      groups: [...groups.values()].map((group) => ({
        ...group,
        deactivateUrl: group.alertId ? tokenUrl({ alertId: group.alertId }) : null,
        items: group.items.map((item) => ({ ...item, url: saleUrl(item) })),
      })),
      hiddenCount,
      alertsUrl,
      unsubscribeUrl,
      disclaimer,
      intro,
    }),
    unsubscribeUrl,
    oneClickUnsubscribe: true,
  };
}

async function deliverEmailAlertDigest({
  userId,
  notifications,
  config,
  now,
  fetchImpl,
  env,
}: {
  userId: string;
  notifications: NotificationRow[];
  config: ActiveEmailAlertDeliveryConfig;
  now: Date;
  fetchImpl: typeof fetch;
  env: Pick<NodeJS.ProcessEnv, string>;
}): Promise<{ outcomes: EmailAlertDeliveryOutcome[]; skipped: number }> {
  const failAll = async (detail: string, recipient: string | null) => {
    for (const notification of notifications) {
      await markEmailNotificationFailed({ notification, now, detail, recipient });
    }
    return {
      skipped: 0,
      outcomes: notifications.map((notification) => ({
        notificationId: notification.id,
        status: "failed" as const,
        recipient,
        messageId: null,
        detail,
      })),
    };
  };

  // The consent and the plan are checked again right before sending: the user
  // may have unsubscribed or lost the subscription since the match was queued.
  const eligibility = await readEmailEligibility(userId);
  if (!eligibility.eligible) {
    await cancelQueuedEmailNotifications({ userId, now, reason: eligibility.reason });
    return { outcomes: [], skipped: notifications.length };
  }

  const activeAlertIds = await readActiveAlertIds(userId);
  // A free account only receives the discovery digest; matches queued while it
  // still had Analyse are not sent once the plan has ended.
  const sendable = notifications.filter(
    (notification) =>
      (!notification.alert_id || activeAlertIds.has(notification.alert_id)) &&
      (eligibility.audience === "analyse" || notificationAudience(notification) === "discovery"),
  );
  const stale = notifications.filter((notification) => !sendable.includes(notification));
  for (const notification of stale) {
    await markEmailNotificationCancelled({ notification, now });
  }
  if (!sendable.length) return { outcomes: [], skipped: stale.length };

  const recipient = await readUserEmail(userId);
  if (!recipient) {
    return failAll("Aucune adresse email confirmée disponible pour cet utilisateur.", null);
  }

  const message = buildAlertDigestMessage({
    userId,
    notifications: sendable,
    recipientEmail: recipient,
    from: config.from,
    appUrl: config.appUrl,
    now,
    env,
  });
  const digestKey = createHash("sha256")
    .update(
      sendable
        .map((notification) => notification.id)
        .sort()
        .join(","),
    )
    .digest("hex")
    .slice(0, 24);

  try {
    const sendResult = await sendResendEmail({
      apiKey: config.apiKey,
      message,
      idempotencyKey: `immojudis-alert-digest-${userId}-${digestKey}`,
      fetchImpl,
    });
    for (const notification of sendable) {
      await markEmailNotificationSent({
        notification,
        now,
        recipient,
        messageId: sendResult.id,
      });
    }
    return {
      skipped: stale.length,
      outcomes: sendable.map((notification) => ({
        notificationId: notification.id,
        status: "sent" as const,
        recipient,
        messageId: sendResult.id,
        detail: null,
      })),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Envoi email impossible.";
    for (const notification of sendable) {
      await markEmailNotificationFailed({ notification, now, detail, recipient });
    }
    return {
      skipped: stale.length,
      outcomes: sendable.map((notification) => ({
        notificationId: notification.id,
        status: "failed" as const,
        recipient,
        messageId: null,
        detail,
      })),
    };
  }
}

async function readEmailEligibility(
  userId: string,
): Promise<
  { eligible: true; audience: "analyse" | "discovery" } | { eligible: false; reason: string }
> {
  const { data, error } = await supabaseAdmin
    .from("user_notification_preferences")
    .select("alert_email_enabled,alert_email_consented_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (
    !canCreateEmailAlertNotification({
      alertEmailEnabled: data?.alert_email_enabled ?? false,
      alertEmailConsentedAt: data?.alert_email_consented_at ?? null,
    })
  ) {
    return { eligible: false, reason: "consent_revoked" };
  }
  const plan = await resolvePlanEntitlements(await systemAuthForUser(userId));
  return { eligible: true, audience: plan.hasAnalysisAccess ? "analyse" : "discovery" };
}

function notificationAudience(notification: { notification_snapshot?: unknown }): string | null {
  const snapshot = notification.notification_snapshot;
  return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? String((snapshot as Record<string, unknown>).audience ?? "") || null
    : null;
}

async function readActiveAlertIds(userId: string): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin
    .from("user_alerts")
    .select("id")
    .eq("user_id", userId)
    .eq("is_active", true);
  if (error) throw error;
  return new Set((data ?? []).map((row) => row.id));
}

async function markEmailNotificationCancelled({
  notification,
  now,
}: {
  notification: NotificationRow;
  now: Date;
}) {
  const { error } = await supabaseAdmin
    .from("user_alert_notifications")
    .update({ delivery_status: "cancelled", updated_at: now.toISOString() })
    .eq("id", notification.id)
    .eq("delivery_channel", "email")
    .eq("delivery_status", "queued");
  if (error) throw error;
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
  if (message.replyTo) payload.reply_to = message.replyTo;
  if (message.unsubscribeUrl) {
    payload.headers = {
      "List-Unsubscribe": `<${message.unsubscribeUrl}>`,
      ...(message.oneClickUnsubscribe
        ? { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
        : {}),
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

/**
 * L'adresse email du compte, ou `null` quand il n'en a pas OU qu'elle n'est pas confirmée
 * (`email_confirmed_at`) : on n'écrit jamais (alertes comme rappels d'audience) à une adresse que
 * personne n'a prouvé lire.
 */
export async function readUserEmail(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error) throw error;
  if (!data.user?.email_confirmed_at) return null;
  const email = data.user.email?.trim();
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

function buildAlertDigestHtml({
  groups,
  hiddenCount,
  alertsUrl,
  unsubscribeUrl,
  disclaimer,
  intro,
}: {
  groups: Array<{
    alertName: string;
    deactivateUrl: string | null;
    items: Array<DigestItem & { url: string }>;
  }>;
  hiddenCount: number;
  alertsUrl: string;
  unsubscribeUrl: string;
  disclaimer: string;
  intro: string;
}): string {
  const sections = groups
    .map((group) => {
      const items = group.items
        .map((item) => {
          const reasons = item.reasons
            .map((reason) => `<li style="margin: 0 0 4px;">${escapeHtml(reason)}</li>`)
            .join("");
          return `<div style="margin:0 0 18px;padding:0 0 16px;border-bottom:1px solid #eee7d8;">
          <h2 style="margin:0 0 4px;font-size:18px;line-height:1.3;color:#182033;">${escapeHtml(item.title)}</h2>
          ${item.location ? `<p style="margin:0 0 8px;color:#6c7280;">${escapeHtml(item.location)}</p>` : ""}
          ${saleFactsLine(item) ? `<p style="margin:0 0 8px;color:#182033;">${escapeHtml(saleFactsLine(item) ?? "")}</p>` : ""}
          ${item.discountLine ? `<p style="margin:0 0 8px;font-weight:700;color:#182033;">${escapeHtml(item.discountLine)}</p>` : ""}
          ${reasons ? `<ul style="margin:0 0 12px;padding-left:18px;color:#4b5563;">${reasons}</ul>` : ""}
          <a href="${escapeAttribute(item.url)}" style="display:inline-block;background:#182033;color:#fff;text-decoration:none;border-radius:8px;padding:10px 14px;font-weight:700;">Voir l'annonce</a>
        </div>`;
        })
        .join("");
      return `<p style="margin:0 0 12px;color:#7a5f1f;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">${escapeHtml(group.alertName)}</p>
      ${items}
      ${
        group.deactivateUrl
          ? `<p style="margin:0 0 22px;font-size:12px;"><a href="${escapeAttribute(group.deactivateUrl)}" style="color:#6c7280;">Désactiver cette alerte</a></p>`
          : ""
      }`;
    })
    .join("");

  return `<!doctype html>
<html lang="fr">
  <body style="margin:0;background:#f6f4ef;color:#182033;font-family:Arial,sans-serif;">
    <div style="max-width:620px;margin:0 auto;padding:28px 18px;">
      <div style="background:#fff;border:1px solid #e8e1d4;border-radius:10px;padding:24px;">
        <p style="margin:0 0 8px;font-size:16px;">Bonjour,</p>
        <p style="margin:0 0 18px;color:#4b5563;">${escapeHtml(intro)}</p>
        ${sections}
        ${
          hiddenCount > 0
            ? `<p style="margin:0 0 16px;"><a href="${escapeAttribute(alertsUrl)}" style="color:#182033;font-weight:700;">… et ${hiddenCount} autre${hiddenCount > 1 ? "s" : ""} vente${hiddenCount > 1 ? "s" : ""} sur Immojudis</a></p>`
            : ""
        }
        <p style="margin:12px 0 0;color:#6c7280;font-size:12px;line-height:1.5;">${escapeHtml(disclaimer)}</p>
      </div>
      <p style="margin:14px 0 0;text-align:center;color:#6c7280;font-size:12px;">
        <a href="${escapeAttribute(alertsUrl)}" style="color:#6c7280;">Gérer mes alertes</a> ·
        <a href="${escapeAttribute(unsubscribeUrl)}" style="color:#6c7280;">Se désinscrire des alertes email</a>
      </p>
    </div>
  </body>
</html>`;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
