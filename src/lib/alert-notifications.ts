import "server-only";
import { z } from "zod";
import { PublicApiError } from "@/lib/api-errors";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  dispatchQueuedEmailAlertNotifications,
  resolveEmailAlertDeliveryConfig,
} from "@/lib/email-alerts";
import { alertNotificationsMode, type EmailFeatureMode } from "@/lib/email-feature-mode";
import { emailAlertConsentEnabled } from "@/lib/notification-preferences";
import { assertFeatureEntitlement } from "@/lib/property-reports";
import { cleanSaleTitle } from "@/lib/sale-title";
import type { UserAlert } from "@/lib/types";
import { asRecord, numberValue, stringValue } from "@/lib/guards";

type NotificationRow = Database["public"]["Tables"]["user_alert_notifications"]["Row"];
type NotificationInsert = Database["public"]["Tables"]["user_alert_notifications"]["Insert"];
type NotificationUpdate = Database["public"]["Tables"]["user_alert_notifications"]["Update"];

export type AlertNotificationKind = NotificationRow["notification_kind"];
export type AlertNotificationDeliveryStatus = NotificationRow["delivery_status"];

export type AlertNotificationMatchInput = {
  id: string | null;
  alertId: string;
  alertName: string;
  saleId: string;
  saleTitle: string | null;
  city: string | null;
  department: string | null;
  startingPriceEur: number | null;
  saleDate: string | null;
  reasons: string[];
  marketDiscountPct: number | null;
  matchedAt: string;
};

export type AlertNotificationSummary = {
  id: string;
  alertId: string;
  matchId: string;
  saleId: string;
  alertName: string;
  saleTitle: string | null;
  city: string | null;
  department: string | null;
  reasons: string[];
  marketDiscountPct: number | null;
  notificationKind: AlertNotificationKind;
  deliveryChannel: NotificationRow["delivery_channel"];
  deliveryStatus: AlertNotificationDeliveryStatus;
  scheduledFor: string;
  sentAt: string | null;
  readAt: string | null;
  dismissedAt: string | null;
  createdAt: string;
};

export type AlertNotificationListResponse = {
  notifications: AlertNotificationSummary[];
};

export type AlertNotificationCreateResult = {
  notificationCount: number;
};

export type AlertNotificationDispatchResult = {
  ok: true;
  startedAt: string;
  finishedAt: string;
  candidateCount: number;
  dispatchedCount: number;
  notifications: AlertNotificationSummary[];
  emailCandidateCount: number;
  emailDispatchedCount: number;
  emailFailedCount: number;
  emailSkippedCount: number;
  emailProviderConfigured: boolean;
  /** Variables d'environnement manquantes quand l'envoi d'e-mails n'est pas configuré. */
  emailMissingConfig: string[];
  /** Interrupteur `ALERT_NOTIFICATIONS_MODE` appliqué à ce passage. */
  emailMode: EmailFeatureMode;
  /** E-mails dus laissés en file par l'interrupteur (`off` : tous, `internal` : ceux des non-administrateurs). */
  emailHeldBackCount: number;
};

/** Part d'e-mails dus en échec à partir de laquelle le passage est déclaré en échec. */
export const EMAIL_FAILURE_RATE_THRESHOLD = 0.2;

/**
 * Un passage dont les e-mails ne sont pas partis ne compte pas comme un succès : sinon la
 * supervision (`cron.stale`) ne voit rien et les alertes e-mail restent en file sans bruit. Échoue
 * quand au moins un e-mail est dû et que l'envoi n'est pas configuré (Resend, expéditeur, adresse du
 * site), ou quand 20 % au moins des e-mails dus ont échoué. Les notifications dans l'application ont
 * déjà été publiées : le rattrapage ne reprend que les e-mails encore en file.
 */
export function assertAlertNotificationDispatchComplete(
  result: Pick<
    AlertNotificationDispatchResult,
    "emailCandidateCount" | "emailFailedCount" | "emailProviderConfigured" | "emailMissingConfig"
  >,
): void {
  if (result.emailCandidateCount <= 0) return;
  if (!result.emailProviderConfigured) {
    const missing = result.emailMissingConfig.length
      ? ` (variable(s) manquante(s) : ${result.emailMissingConfig.join(", ")})`
      : "";
    throw new Error(
      `Alertes e-mail : ${result.emailCandidateCount} envoi(s) dû(s) mais l'envoi d'e-mails n'est pas configuré${missing}.`,
    );
  }
  if (result.emailFailedCount / result.emailCandidateCount >= EMAIL_FAILURE_RATE_THRESHOLD) {
    throw new Error(
      `Alertes e-mail : ${result.emailFailedCount} envoi(s) en échec sur ${result.emailCandidateCount} dû(s) (seuil ${EMAIL_FAILURE_RATE_THRESHOLD * 100} %).`,
    );
  }
}

export type DispatchableAlertNotification = Pick<
  NotificationRow,
  "id" | "delivery_channel" | "delivery_status" | "scheduled_for"
>;

const DEFAULT_ALERT_NOTIFICATION_DISPATCH_LIMIT = 200;
const MAX_ALERT_NOTIFICATION_DISPATCH_LIMIT = 1_000;

export async function listAlertNotifications({
  auth,
  limit = 50,
  includeDismissed = false,
  includeQueued = false,
}: {
  auth: SupabaseAuthContext;
  limit?: number;
  includeDismissed?: boolean;
  includeQueued?: boolean;
}): Promise<AlertNotificationListResponse> {
  await assertFeatureEntitlement(
    auth,
    "alerts.advanced",
    "Notifications d'alertes réservées à l’offre Analyse.",
  );

  let query = auth.supabase
    .from("user_alert_notifications")
    .select("*")
    .eq("user_id", auth.userId)
    .eq("delivery_channel", "in_app")
    .order("scheduled_for", { ascending: false })
    .limit(clampLimit(limit, 200));

  if (!includeDismissed) query = query.is("dismissed_at", null);
  if (!includeQueued) query = query.eq("delivery_status", "sent");

  const { data, error } = await query;
  if (error) throw error;

  return {
    notifications: (data ?? []).map(notificationRowToSummary),
  };
}

export async function createAlertNotificationsForMatches({
  auth,
  matches,
  alerts,
  now = new Date(),
  discovery = false,
}: {
  auth: SupabaseAuthContext;
  matches: AlertNotificationMatchInput[];
  alerts: Pick<UserAlert, "id" | "alert_frequency">[];
  now?: Date;
  discovery?: boolean;
}): Promise<AlertNotificationCreateResult> {
  // Free accounts get their single alert by email too, as a weekly digest.
  const includeEmail = await emailAlertConsentEnabled(auth);
  const rows = buildAlertNotificationRows({
    userId: auth.userId,
    matches,
    alerts,
    now,
    includeEmail,
    discovery,
  });

  if (!rows.length) return { notificationCount: 0 };

  const { data, error } = await supabaseAdmin
    .from("user_alert_notifications")
    .upsert(rows, {
      onConflict: "user_id,match_id,notification_kind,delivery_channel",
      ignoreDuplicates: true,
    })
    .select("id");

  if (error) throw error;
  return { notificationCount: data?.length ?? 0 };
}

/**
 * Enregistre, au statut « cancelled », les notifications des correspondances que la base silencieuse a tues
 * (`alert-matches.ts`, changement de loyers de référence). La clé d'unicité (compte, correspondance, genre, canal)
 * bloque alors toute création ultérieure : sans ces lignes, la même vente relue au passage suivant (le pipeline
 * réécrit `updated_at`) retrouverait une correspondance sans notification et la notifierait. Les deux canaux sont
 * couverts, consentement aux e-mails ou non, puisque le consentement peut être donné plus tard. Une ligne annulée
 * n'est ni envoyée ni affichée (seul « sent » s'affiche, seul « queued » part). Jamais d'écrasement : une
 * notification déjà créée pour la correspondance reste telle quelle.
 */
export async function suppressAlertNotificationsForMatches({
  auth,
  matches,
  alerts,
  now = new Date(),
  discovery = false,
}: {
  auth: SupabaseAuthContext;
  matches: AlertNotificationMatchInput[];
  alerts: Pick<UserAlert, "id" | "alert_frequency">[];
  now?: Date;
  discovery?: boolean;
}): Promise<{ suppressedCount: number }> {
  const rows = buildAlertNotificationRows({
    userId: auth.userId,
    matches,
    alerts,
    now,
    includeEmail: true,
    discovery,
  }).map((row) => ({ ...row, delivery_status: "cancelled" as const }));
  if (!rows.length) return { suppressedCount: 0 };

  const { data, error } = await supabaseAdmin
    .from("user_alert_notifications")
    .upsert(rows, {
      onConflict: "user_id,match_id,notification_kind,delivery_channel",
      ignoreDuplicates: true,
    })
    .select("id");

  if (error) throw error;
  return { suppressedCount: data?.length ?? 0 };
}

export const ALERT_NOTIFICATION_ACTIONS = ["read", "unread", "dismiss", "restore"] as const;
export type AlertNotificationAction = (typeof ALERT_NOTIFICATION_ACTIONS)[number];

/** Corps de `PATCH /api/alerts/notifications` : une action hors de la liste est refusée, jamais devinée. */
export const alertNotificationUpdateSchema = z.object({
  notificationId: z.string().uuid(),
  action: z.enum(ALERT_NOTIFICATION_ACTIONS),
});

export async function updateAlertNotificationState({
  auth,
  notificationId,
  action,
}: {
  auth: SupabaseAuthContext;
  notificationId: string;
  action: AlertNotificationAction;
}): Promise<{ notification: AlertNotificationSummary }> {
  await assertFeatureEntitlement(
    auth,
    "alerts.advanced",
    "Notifications d'alertes réservées à l’offre Analyse.",
  );

  const now = new Date().toISOString();
  let patch: { read_at: string | null } | { dismissed_at: string | null };
  switch (action) {
    case "read":
      patch = { read_at: now };
      break;
    case "unread":
      patch = { read_at: null };
      break;
    case "dismiss":
      patch = { dismissed_at: now };
      break;
    case "restore":
      patch = { dismissed_at: null };
      break;
    default:
      // Défense en profondeur : l'appelant valide déjà l'action ; une valeur inconnue ne touche à rien.
      throw new PublicApiError("Action de notification invalide.", 400);
  }

  const { data, error } = await auth.supabase
    .from("user_alert_notifications")
    .update({
      ...patch,
      updated_at: now,
    })
    .eq("id", notificationId)
    .eq("user_id", auth.userId)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  // Notification inconnue ou d'un autre compte : 404, pas une erreur du serveur.
  if (!data) throw new PublicApiError("Notification introuvable.", 404);
  return { notification: notificationRowToSummary(data) };
}

async function readAdminUserIds(userIds: string[]): Promise<Set<string>> {
  const admins = new Set<string>();
  for (let from = 0; from < userIds.length; from += 200) {
    const { data, error } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id")
      .eq("user_role", "admin")
      .in("user_id", userIds.slice(from, from + 200));
    if (error) throw error;
    for (const row of data ?? []) admins.add(row.user_id);
  }
  return admins;
}

/**
 * Applique l'interrupteur `ALERT_NOTIFICATIONS_MODE` aux e-mails dus : `on` les laisse tous partir,
 * `internal` ne garde que ceux des administrateurs, `off` n'en garde aucun. Les e-mails écartés
 * restent en file (`queued`), ni envoyés ni annulés.
 */
export async function filterEmailNotificationsByMode({
  mode,
  notifications,
  loadAdminUserIds = readAdminUserIds,
}: {
  mode: EmailFeatureMode;
  notifications: NotificationRow[];
  loadAdminUserIds?: (userIds: string[]) => Promise<Set<string>>;
}): Promise<{ allowed: NotificationRow[]; heldBackCount: number }> {
  if (mode === "on") return { allowed: notifications, heldBackCount: 0 };
  if (mode === "off" || !notifications.length) {
    return { allowed: [], heldBackCount: notifications.length };
  }
  const admins = await loadAdminUserIds([
    ...new Set(notifications.map((notification) => notification.user_id)),
  ]);
  const allowed = notifications.filter((notification) => admins.has(notification.user_id));
  return { allowed, heldBackCount: notifications.length - allowed.length };
}

export async function dispatchDueAlertNotifications({
  now = new Date(),
  limit = DEFAULT_ALERT_NOTIFICATION_DISPATCH_LIMIT,
  emailMode = alertNotificationsMode(),
}: {
  now?: Date;
  limit?: number;
  emailMode?: EmailFeatureMode;
} = {}): Promise<AlertNotificationDispatchResult> {
  const startedAt = new Date().toISOString();
  const dueAt = now.toISOString();
  const dispatchLimit = clampLimit(limit, MAX_ALERT_NOTIFICATION_DISPATCH_LIMIT);
  let candidateQuery = supabaseAdmin
    .from("user_alert_notifications")
    .select("*")
    .eq("delivery_status", "queued")
    .lte("scheduled_for", dueAt);
  // Emails coupés : leur file ne doit pas occuper la fenêtre de lecture au détriment des
  // notifications dans l'application.
  if (emailMode === "off") candidateQuery = candidateQuery.eq("delivery_channel", "in_app");
  const { data: candidates, error: selectError } = await candidateQuery
    .order("scheduled_for", { ascending: true })
    .limit(dispatchLimit);

  if (selectError) throw selectError;

  const candidateRows = candidates ?? [];
  const dueIds = selectDueAlertNotificationIds({
    notifications: candidateRows,
    now,
    limit: dispatchLimit,
  });
  const remainingEmailLimit = Math.max(0, dispatchLimit - dueIds.length);
  const emailCandidates = remainingEmailLimit
    ? selectDueEmailAlertNotifications({
        notifications: candidateRows,
        now,
        limit: remainingEmailLimit,
      })
    : [];

  let dispatchedRows: NotificationRow[] = [];
  if (dueIds.length) {
    const dispatchPatch = buildAlertNotificationDispatchPatch(now);
    const { data, error: updateError } = await supabaseAdmin
      .from("user_alert_notifications")
      .update(dispatchPatch)
      .in("id", dueIds)
      .eq("delivery_channel", "in_app")
      .eq("delivery_status", "queued")
      .lte("scheduled_for", dueAt)
      .select("*");

    if (updateError) throw updateError;
    dispatchedRows = data ?? [];
  }

  const { allowed: emailsToSend, heldBackCount } = await filterEmailNotificationsByMode({
    mode: emailMode,
    notifications: emailCandidates,
  });
  // Mode `off` : rien n'est envoyé et la configuration d'envoi n'est pas exigée (le passage reste vert).
  const emailDispatch =
    emailMode === "off"
      ? { candidateCount: 0, sentCount: 0, failedCount: 0, skippedCount: 0, ...emailConfigStatus() }
      : await dispatchQueuedEmailAlertNotifications({ notifications: emailsToSend, now });
  const notifications = (dispatchedRows ?? []).map(notificationRowToSummary);
  return {
    ok: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    candidateCount: candidateRows.length,
    dispatchedCount: notifications.length,
    notifications,
    emailCandidateCount: emailDispatch.candidateCount,
    emailDispatchedCount: emailDispatch.sentCount,
    emailFailedCount: emailDispatch.failedCount,
    emailSkippedCount: emailDispatch.skippedCount,
    emailProviderConfigured: emailDispatch.configured,
    emailMissingConfig: emailDispatch.missing,
    emailMode,
    emailHeldBackCount: heldBackCount,
  };
}

function emailConfigStatus() {
  const config = resolveEmailAlertDeliveryConfig();
  return { configured: config.configured, missing: config.missing };
}

export function buildAlertNotificationRows({
  userId,
  matches,
  alerts,
  now = new Date(),
  includeEmail = false,
  discovery = false,
}: {
  userId: string;
  matches: AlertNotificationMatchInput[];
  alerts: Pick<UserAlert, "id" | "alert_frequency">[];
  now?: Date;
  includeEmail?: boolean;
  discovery?: boolean;
}): NotificationInsert[] {
  const frequencyByAlert = new Map(alerts.map((alert) => [alert.id, alert.alert_frequency]));

  return matches
    .filter((match) => match.id)
    .flatMap((match) => {
      const frequency = frequencyByAlert.get(match.alertId) ?? "daily";
      const notificationKind = notificationKindForFrequency(frequency);
      const scheduledFor = scheduledForFrequency(frequency, now);
      const snapshot = asJson({
        ...buildNotificationSnapshot({
          match: discovery
            ? {
                ...match,
                saleTitle: "Vente immobilière",
                marketDiscountPct: null,
                reasons: ["Critères publics correspondants"],
              }
            : match,
          frequency,
        }),
        audience: discovery ? "discovery" : "analyse",
      });
      const inAppRow: NotificationInsert = {
        user_id: userId,
        alert_id: match.alertId,
        match_id: match.id as string,
        sale_id: match.saleId,
        notification_kind: notificationKind,
        delivery_channel: "in_app",
        delivery_status: "queued",
        scheduled_for: scheduledFor,
        sent_at: null,
        notification_snapshot: snapshot,
      };

      if (!includeEmail) return [inAppRow];

      return [
        inAppRow,
        {
          user_id: userId,
          alert_id: match.alertId,
          match_id: match.id as string,
          sale_id: match.saleId,
          notification_kind: notificationKind,
          delivery_channel: "email",
          delivery_status: "queued",
          scheduled_for: scheduledFor,
          sent_at: null,
          notification_snapshot: snapshot,
        },
      ];
    });
}

export function selectDueAlertNotificationIds({
  notifications,
  now = new Date(),
  limit = DEFAULT_ALERT_NOTIFICATION_DISPATCH_LIMIT,
}: {
  notifications: DispatchableAlertNotification[];
  now?: Date;
  limit?: number;
}): string[] {
  const dueAt = now.getTime();
  return notifications
    .filter((notification) => {
      const scheduledAt = Date.parse(notification.scheduled_for);
      return (
        notification.delivery_channel === "in_app" &&
        notification.delivery_status === "queued" &&
        Number.isFinite(scheduledAt) &&
        scheduledAt <= dueAt
      );
    })
    .sort((left, right) => Date.parse(left.scheduled_for) - Date.parse(right.scheduled_for))
    .slice(0, clampLimit(limit, MAX_ALERT_NOTIFICATION_DISPATCH_LIMIT))
    .map((notification) => notification.id);
}

export function selectDueEmailAlertNotifications({
  notifications,
  now = new Date(),
  limit = DEFAULT_ALERT_NOTIFICATION_DISPATCH_LIMIT,
}: {
  notifications: NotificationRow[];
  now?: Date;
  limit?: number;
}): NotificationRow[] {
  const dueAt = now.getTime();
  return notifications
    .filter((notification) => {
      const scheduledAt = Date.parse(notification.scheduled_for);
      return (
        notification.delivery_channel === "email" &&
        notification.delivery_status === "queued" &&
        Number.isFinite(scheduledAt) &&
        scheduledAt <= dueAt
      );
    })
    .sort((left, right) => Date.parse(left.scheduled_for) - Date.parse(right.scheduled_for))
    .slice(0, clampLimit(limit, MAX_ALERT_NOTIFICATION_DISPATCH_LIMIT));
}

export function buildAlertNotificationDispatchPatch(now = new Date()): NotificationUpdate {
  const sentAt = now.toISOString();
  return {
    delivery_status: "sent",
    sent_at: sentAt,
    updated_at: sentAt,
  };
}

export function notificationKindForFrequency(
  frequency: UserAlert["alert_frequency"],
): AlertNotificationKind {
  // "instant" was never delivered in real time: it is folded into the daily digest.
  if (frequency === "weekly") return "weekly_digest";
  return "daily_digest";
}

export function scheduledForFrequency(
  frequency: UserAlert["alert_frequency"],
  now = new Date(),
): string {
  const scheduled = new Date(now);
  if (frequency === "weekly") {
    const day = scheduled.getUTCDay();
    const daysUntilMonday = (8 - day) % 7 || 7;
    scheduled.setUTCDate(scheduled.getUTCDate() + daysUntilMonday);
  } else {
    scheduled.setUTCDate(scheduled.getUTCDate() + 1);
  }
  scheduled.setUTCHours(7, 0, 0, 0);
  return scheduled.toISOString();
}

function buildNotificationSnapshot({
  match,
  frequency,
}: {
  match: AlertNotificationMatchInput;
  frequency: UserAlert["alert_frequency"];
}) {
  return {
    alert: {
      id: match.alertId,
      name: match.alertName,
      frequency,
    },
    sale: {
      id: match.saleId,
      title: cleanSaleTitle(match.saleTitle),
      city: match.city,
      department: match.department,
      startingPriceEur: match.startingPriceEur,
      saleDate: match.saleDate,
    },
    match: {
      id: match.id,
      reasons: match.reasons,
      marketDiscountPct: match.marketDiscountPct,
      matchedAt: match.matchedAt,
    },
  };
}

function notificationRowToSummary(row: NotificationRow): AlertNotificationSummary {
  const snapshot = asRecord(row.notification_snapshot);
  const alert = asRecord(snapshot.alert);
  const sale = asRecord(snapshot.sale);
  const match = asRecord(snapshot.match);

  return {
    id: row.id,
    alertId: row.alert_id,
    matchId: row.match_id,
    saleId: row.sale_id,
    alertName: stringValue(alert.name) || "Alerte",
    saleTitle: cleanSaleTitle(stringValue(sale.title)),
    city: stringValue(sale.city),
    department: stringValue(sale.department),
    reasons: arrayOfStrings(match.reasons),
    marketDiscountPct: numberValue(match.marketDiscountPct),
    notificationKind: row.notification_kind,
    deliveryChannel: row.delivery_channel,
    deliveryStatus: row.delivery_status,
    scheduledFor: row.scheduled_for,
    sentAt: row.sent_at,
    readAt: row.read_at,
    dismissedAt: row.dismissed_at,
    createdAt: row.created_at,
  };
}

function asJson(value: Record<string, unknown>): Json {
  return value as Json;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function clampLimit(value: number, max: number): number {
  return Math.max(1, Math.min(max, Math.floor(value || 1)));
}
