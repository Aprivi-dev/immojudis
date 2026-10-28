import "server-only";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { createHash } from "node:crypto";
import { serverEnv } from "@/lib/env";
import { emailClickUrl, isEmailClickSaleId } from "@/lib/email-click-token";
import { createUnsubscribeToken } from "@/lib/email-unsubscribe-token";
import { canCreateEmailAlertNotification } from "@/lib/notification-preferences";
import { setOfferOpeningNotification } from "@/lib/offer-opening-notification";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import { cleanSaleTitle } from "@/lib/sale-title";
import { resolveSiteOrigin } from "@/lib/site-url";
import { systemAuthForUser } from "@/lib/system-auth";
import { asRecord, escapeHtml, numberValue, stringValue } from "@/lib/guards";
import { listPepiteSaleIds, type PepiteIdsClient } from "@/lib/pepite-sale-ids";
import { EMAIL_COLORS, EMAIL_FONT_STACK, emailBrandHeaderHtml } from "@/lib/email-brand";
import {
  PEPITE_EXPLANATION,
  PEPITE_LABEL,
  PEPITE_METHOD_LINK_LABEL,
  PEPITE_METHOD_PATH,
} from "@/lib/pepite-copy";
import {
  ANIL_CURRENT_EDITION,
  RENT_ATTRIBUTION,
  RENT_SOURCE_URL,
  rentSourceDetail,
} from "@/lib/rent-source-notice";

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
  /** Variables d'environnement manquantes quand l'envoi n'est pas configuré (vide sinon). */
  missing: string[];
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

/**
 * Catégorie d'un envoi, transmise à Resend comme étiquette (`tags`) : elle permet de ventiler rebonds et
 * plaintes par type de message avant de lire le seuil de chaque catégorie. Valeurs en ASCII (lettres,
 * chiffres, tirets bas), comme l'exige Resend.
 */
export const EMAIL_CATEGORIES = [
  "alert",
  "reminder",
  "weekly",
  "result",
  "billing",
  "acceptance",
  "opening",
  "launch_offer_end",
  "lawyer",
  "agent",
  "operations",
] as const;
export type EmailCategory = (typeof EMAIL_CATEGORIES)[number];

export type AlertEmailMessage = ResendEmailMessage & {
  unsubscribeUrl: string;
};

const notificationIdSchema = z.string().guid();

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

/**
 * Configuration d'envoi des messages liés au contrat (facturation, acceptation commerciale) : un
 * expéditeur à part, `TRANSACTIONAL_EMAIL_FROM` (par exemple `compte@immojudis.com`), pour qu'une
 * plainte sur les alertes ne dégrade pas la réputation de l'adresse qui porte aussi ces messages.
 * Absent, le message part de l'expéditeur des alertes, comme avant.
 */
export function resolveTransactionalEmailConfig(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): EmailAlertDeliveryConfig {
  const config = resolveEmailAlertDeliveryConfig(env);
  const transactionalFrom = serverEnv(env).email.transactionalFrom;
  if (!transactionalFrom) return config;
  // L'expéditeur des alertes n'est plus requis pour ces messages.
  const missing = config.missing.filter((name) => name !== "ALERT_EMAIL_FROM");
  return { ...config, from: transactionalFrom, missing, configured: missing.length === 0 };
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
  /** La vente correspond à une alerte « Seulement les pépites » : une mention en texte, jamais un montant. */
  pepite: boolean;
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
      missing: config.missing,
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
    missing: [],
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

/**
 * Retire le consentement au récapitulatif hebdomadaire « Ma semaine » (désinscription par le lien
 * signé de chaque email, portée « weekly-digest »). Les autres consentements ne sont pas touchés ; la
 * date du retrait est posée par la base (déclencheur de la migration 20261030120000).
 */
export async function revokeWeeklyDigestConsent({
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
      weekly_digest_enabled: false,
      weekly_digest_revoked_at: revokedAt,
    },
    { onConflict: "user_id" },
  );
  if (error) throw error;
  return { userId, revokedAt };
}

/**
 * Retire le consentement à l'alerte de résultat ou de remise en vente (désinscription par le lien
 * signé de chaque email, portée « sale-results »). Les autres consentements ne sont pas touchés.
 */
export async function revokeSaleResultsConsent({
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
      sale_results_enabled: false,
      sale_results_revoked_at: revokedAt,
    },
    { onConflict: "user_id" },
  );
  if (error) throw error;
  return { userId, revokedAt };
}

/**
 * Retire la demande d'être prévenu de l'ouverture de l'offre Analyse (désinscription par le lien
 * signé de l'email d'ouverture, portée « offer-opening »). Même écriture que le bouton de /offres :
 * la demande est retirée avec ses réponses facultatives, la preuve du consentement reste.
 */
export async function revokeOfferOpeningRequest({
  userId,
  now = new Date(),
}: {
  userId: string;
  now?: Date;
}): Promise<{ userId: string; revokedAt: string }> {
  await setOfferOpeningNotification({
    auth: { userId },
    admin: supabaseAdmin,
    input: { enabled: false },
    now,
  });
  return { userId, revokedAt: now.toISOString() };
}

/**
 * Désinscription du préavis de fin de l'offre de lancement (lien du message) : le compte entre dans la
 * liste d'exclusion et n'est plus jamais dans la file d'envoi, pour aucune date. Rien d'autre ne change.
 */
export async function revokeLaunchOfferEndNotice({ userId }: { userId: string }): Promise<void> {
  const { error } = await supabaseAdmin
    .from("launch_offer_end_notice_optouts")
    .upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true });
  if (error) throw error;
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

const PEPITE_REASON = "pépite";
/** Motif écrit par `alertMatchesSale` quand l'alerte filtre sur le rendement. */
const RENT_YIELD_REASON = "rendement";
/**
 * Mention de l'email : le texte validé et relu par le juridique le 26/10/2026, mot pour mot (`PEPITE_EXPLANATION`),
 * en texte comme en HTML. Jamais un montant (la page de la vente porte le détail, selon le droit du compte).
 */
const PEPITE_EMAIL_LINE = PEPITE_EXPLANATION;

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
    // « pépite » n'est pas un critère comme les autres : il a sa mention (sans montant) et son lien.
    reasons: arrayOfStrings(match.reasons)
      .filter((reason) => reason !== PEPITE_REASON)
      .slice(0, 4),
    pepite: arrayOfStrings(match.reasons).includes(PEPITE_REASON),
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
  alertActivatedAt,
  audience = "analyse",
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
  /** Date d'activation de chaque alerte (identifiant → ISO), pour la raison de réception du pied. */
  alertActivatedAt?: ReadonlyMap<string, string | null>;
  /**
   * Un compte Découverte ne lit pas la liste des notifications (`alerts.advanced`) : « … et N autres »
   * le mène au catalogue public, pas à `/alertes`.
   */
  audience?: "analyse" | "discovery";
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

  // Une alerte qui filtre sur le rendement cite le loyer de la carte de l'ANIL : sa mention (Licence Ouverte 2.0)
  // et le lien vers la source figurent au pied de l'email.
  const rentNotice = items.some((item) => item.reasons.includes(RENT_YIELD_REASON))
    ? `${RENT_ATTRIBUTION} ${rentSourceDetail({ source: "anil_commune", ...ANIL_CURRENT_EDITION }) ?? ""}`.trim()
    : null;

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
      if (item.pepite) {
        textLines.push(
          `  ${PEPITE_LABEL} : ${PEPITE_EMAIL_LINE} ${PEPITE_METHOD_LINK_LABEL} ${appUrl}${PEPITE_METHOD_PATH}`,
        );
      }
      if (item.reasons.length) textLines.push(`  Critères détectés : ${item.reasons.join(", ")}`);
      textLines.push(`  Consulter l'annonce : ${saleUrl(item)}`);
    }
    if (group.alertId) {
      textLines.push("", `Désactiver cette alerte : ${tokenUrl({ alertId: group.alertId })}`);
    }
    textLines.push("");
  }
  const hiddenUrl = audience === "discovery" ? `${appUrl}/sales` : alertsUrl;
  const hiddenLabel = `… et ${hiddenCount} autre${hiddenCount > 1 ? "s" : ""} vente${hiddenCount > 1 ? "s" : ""}${
    audience === "discovery" ? " correspondent à vos alertes (catalogue)" : ""
  }`;
  if (hiddenCount > 0) {
    textLines.push(`${hiddenLabel} : ${hiddenUrl}`, "");
  }
  const receptionReason = receptionReasonLine([...groups.values()], alertActivatedAt);
  textLines.push(disclaimer);
  if (rentNotice) textLines.push("", rentNotice, `Source : ${RENT_SOURCE_URL}`);
  textLines.push(
    "",
    receptionReason,
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
      hiddenLink: { url: hiddenUrl, label: hiddenLabel },
      title: subject,
      preheader:
        allItems.length === 1
          ? (saleFactsLine(items[0]) ?? intro)
          : "Les ventes qui correspondent à vos alertes, avec leur audience et leur mise à prix.",
      receptionReason,
      alertsUrl,
      methodUrl: `${appUrl}${PEPITE_METHOD_PATH}`,
      unsubscribeUrl,
      disclaimer,
      rentNotice,
      intro,
    }),
    unsubscribeUrl,
    oneClickUnsubscribe: true,
  };
}

/** La notification porte la mention « pépite » dans les motifs de sa correspondance. */
export function mentionsPepite(notification: Pick<NotificationRow, "notification_snapshot">) {
  return arrayOfStrings(
    asRecord(asRecord(notification.notification_snapshot).match).reasons,
  ).includes(PEPITE_REASON);
}

/**
 * Retire la mention « pépite » d'un résumé dont la vente n'est plus une pépite publiable (arrêt d'urgence, sortie de
 * la liste, mode repassé en `shadow`) : le résumé a été écrit quand l'alerte a été évaluée, l'email part plus tard.
 * La vérification relit la liste publique avec le rôle de service (`list_public_pepite_sale_ids`) ; une liste
 * illisible retire la mention (on n'affirme rien qu'on n'a pas pu vérifier). Une notification sans mention n'est pas
 * touchée et ne déclenche aucune lecture.
 */
export async function withCurrentPepiteMentions<
  T extends Pick<NotificationRow, "notification_snapshot">,
>(notifications: T[]): Promise<T[]> {
  const mentions = (notification: T) => mentionsPepite(notification);
  if (!notifications.some(mentions)) return notifications;
  let current: ReadonlySet<string>;
  try {
    current = new Set(
      await listPepiteSaleIds({ rpc: (fn) => supabaseAdmin.rpc(fn) } as PepiteIdsClient),
    );
  } catch {
    current = new Set();
  }
  return notifications.map((notification) => {
    if (!mentions(notification)) return notification;
    const snapshot = asRecord(notification.notification_snapshot);
    const saleId = stringValue(asRecord(snapshot.sale).id)?.toLowerCase();
    if (saleId && current.has(saleId)) return notification;
    const match = asRecord(snapshot.match);
    return {
      ...notification,
      notification_snapshot: {
        ...snapshot,
        match: {
          ...match,
          reasons: arrayOfStrings(match.reasons).filter((reason) => reason !== PEPITE_REASON),
        },
      },
    };
  });
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

  const activeAlerts = await readActiveAlerts(userId);
  // A free account only receives the discovery digest; matches queued while it
  // still had Analyse are not sent once the plan has ended.
  const sendable = notifications.filter(
    (notification) =>
      (!notification.alert_id || activeAlerts.has(notification.alert_id)) &&
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

  // Les motifs du résumé d'origine peuvent citer « pépite » pour une vente qui ne l'est plus à l'envoi : le journal
  // garde ce que le message a réellement dit (`pepiteMentioned`), pas ce que le résumé contenait.
  const current = await withCurrentPepiteMentions(sendable);
  const mentioned = new Set(current.filter(mentionsPepite).map((notification) => notification.id));
  const message = buildAlertDigestMessage({
    userId,
    notifications: current,
    recipientEmail: recipient,
    from: config.from,
    appUrl: config.appUrl,
    now,
    env,
    alertActivatedAt: activeAlerts,
    audience: eligibility.audience,
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
      category: "alert",
    });
    for (const notification of sendable) {
      await markEmailNotificationSent({
        notification,
        now,
        recipient,
        messageId: sendResult.id,
        pepiteMentioned: mentioned.has(notification.id),
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

/** Les alertes actives du compte, avec leur date d'activation (création) : la raison de réception du pied. */
async function readActiveAlerts(userId: string): Promise<Map<string, string | null>> {
  const { data, error } = await supabaseAdmin
    .from("user_alerts")
    .select("id, created_at")
    .eq("user_id", userId)
    .eq("is_active", true);
  if (error) throw error;
  return new Map((data ?? []).map((row) => [row.id, row.created_at ?? null]));
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

const REPLY_TO_PATTERN = /^[^\s@<>,;:"]+@[^\s@<>,;:"]+\.[^\s@<>,;:"]{2,}$/;

/**
 * Adresse de réponse des emails envoyés aux comptes (alertes, récapitulatifs, rappels, résultats,
 * mises en relation, ouverture de l'offre) : `EMAIL_REPLY_TO`, à défaut l'adresse de contact publiée
 * (`NEXT_PUBLIC_LEGAL_CONTACT_EMAIL`). Sans elle, une réponse partait vers l'expéditeur technique
 * (« alertes@ »), qu'aucune personne ne lit. `null` si aucune adresse valide n'est configurée.
 */
export function resolveReplyTo(env: Pick<NodeJS.ProcessEnv, string> = process.env): string | null {
  for (const value of [env.EMAIL_REPLY_TO, env.NEXT_PUBLIC_LEGAL_CONTACT_EMAIL]) {
    const address = value?.trim();
    if (address && REPLY_TO_PATTERN.test(address)) return address;
  }
  return null;
}

export async function sendResendEmail({
  apiKey,
  message,
  idempotencyKey,
  fetchImpl,
  category,
}: {
  apiKey: string;
  message: ResendEmailMessage;
  idempotencyKey: string;
  fetchImpl: typeof fetch;
  /** Type de message : étiquette Resend `category`, obligatoire sur chaque envoi. */
  category: EmailCategory;
}): Promise<{ id: string | null }> {
  const payload: Record<string, unknown> = {
    from: message.from,
    to: [message.to],
    subject: message.subject,
    html: message.html,
    text: message.text,
    tags: [{ name: "category", value: category }],
  };
  // `replyTo` absent : l'adresse de réponse du site ; `null` : volontairement aucune.
  const replyTo = message.replyTo === undefined ? resolveReplyTo() : message.replyTo;
  if (replyTo) payload.reply_to = replyTo;
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
    // Without a deadline a stalled call outlives the route and leaves the caller in « sending ».
    // A retry stays safe: the idempotency key makes Resend return the first delivery.
    signal: AbortSignal.timeout(15_000),
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
  pepiteMentioned,
}: {
  notification: NotificationRow;
  now: Date;
  recipient: string;
  messageId: string | null;
  /** Le message envoyé portait la mention « pépite » pour cette vente (après relecture de la liste publique). */
  pepiteMentioned: boolean;
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
        pepiteMentioned,
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

/**
 * Pourquoi cet email arrive : le nom de chaque alerte du message et sa date d'activation. Sans date
 * connue, le nom seul.
 */
function receptionReasonLine(
  groups: Array<{ alertId: string | null; alertName: string }>,
  activatedAt?: ReadonlyMap<string, string | null>,
): string {
  const label = (group: { alertId: string | null; alertName: string }, joiner: string) => {
    const date = formatHearingDate(
      group.alertId ? (activatedAt?.get(group.alertId) ?? null) : null,
    );
    return `« ${group.alertName} »${date ? ` (${joiner} ${date})` : ""}`;
  };
  if (groups.length === 1) {
    const date = formatHearingDate(
      groups[0].alertId ? (activatedAt?.get(groups[0].alertId) ?? null) : null,
    );
    return `Vous recevez ce message parce que vous avez activé l’alerte « ${groups[0].alertName} »${date ? ` le ${date}` : ""}.`;
  }
  return `Vous recevez ce message parce que vous avez activé les alertes ${groups
    .map((group) => label(group, "le"))
    .join(", ")}.`;
}

function buildAlertDigestHtml({
  groups,
  hiddenCount,
  hiddenLink,
  title,
  preheader,
  receptionReason,
  alertsUrl,
  methodUrl,
  unsubscribeUrl,
  disclaimer,
  rentNotice,
  intro,
}: {
  groups: Array<{
    alertName: string;
    deactivateUrl: string | null;
    items: Array<DigestItem & { url: string }>;
  }>;
  hiddenCount: number;
  /** Lien « … et N autres » : la liste des alertes, ou le catalogue pour un compte Découverte. */
  hiddenLink: { url: string; label: string };
  /** Contenu de la balise `<title>` (l'objet du message). */
  title: string;
  /** Texte d'aperçu affiché par la messagerie après l'objet, masqué dans le message. */
  preheader: string;
  /** Pourquoi le message est reçu (nom et date d'activation de l'alerte). */
  receptionReason: string;
  alertsUrl: string;
  /** Page « Comment repérons-nous les pépites ? », liée à la mention « Pépite ». */
  methodUrl: string;
  unsubscribeUrl: string;
  disclaimer: string;
  /** Mention de la carte des loyers de l'ANIL, quand une alerte du message filtre sur le rendement. */
  rentNotice: string | null;
  intro: string;
}): string {
  const sections = groups
    .map((group) => {
      const items = group.items
        .map((item) => {
          const reasons = item.reasons
            .map((reason) => `<li style="margin: 0 0 4px;">${escapeHtml(reason)}</li>`)
            .join("");
          return `<div style="margin:0 0 18px;padding:0 0 16px;border-bottom:1px solid ${EMAIL_COLORS.lineWarm};">
          <h2 style="margin:0 0 4px;font-size:18px;line-height:1.3;color:${EMAIL_COLORS.navy};">${escapeHtml(item.title)}</h2>
          ${item.location ? `<p style="margin:0 0 8px;color:${EMAIL_COLORS.inkSoft};">${escapeHtml(item.location)}</p>` : ""}
          ${saleFactsLine(item) ? `<p style="margin:0 0 8px;color:${EMAIL_COLORS.navy};">${escapeHtml(saleFactsLine(item) ?? "")}</p>` : ""}
          ${item.discountLine ? `<p style="margin:0 0 8px;font-weight:700;color:${EMAIL_COLORS.navy};">${escapeHtml(item.discountLine)}</p>` : ""}
          ${item.pepite ? `<p style="margin:0 0 8px;color:${EMAIL_COLORS.navy};"><strong>${escapeHtml(PEPITE_LABEL)}</strong> : ${escapeHtml(PEPITE_EMAIL_LINE)} <a href="${escapeAttribute(methodUrl)}" style="color:${EMAIL_COLORS.goldText};">${escapeHtml(PEPITE_METHOD_LINK_LABEL)}</a></p>` : ""}
          ${reasons ? `<ul style="margin:0 0 12px;padding-left:18px;color:${EMAIL_COLORS.inkStrong};">${reasons}</ul>` : ""}
          <a href="${escapeAttribute(item.url)}" style="display:inline-block;background:${EMAIL_COLORS.navy};color:#fff;text-decoration:none;border-radius:8px;padding:10px 14px;font-weight:700;">Voir l'annonce</a>
        </div>`;
        })
        .join("");
      return `<p style="margin:0 0 12px;color:${EMAIL_COLORS.goldText};font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">${escapeHtml(group.alertName)}</p>
      ${items}
      ${
        group.deactivateUrl
          ? `<p style="margin:0 0 22px;font-size:12px;"><a href="${escapeAttribute(group.deactivateUrl)}" style="color:${EMAIL_COLORS.inkSoft};">Désactiver cette alerte</a></p>`
          : ""
      }`;
    })
    .join("");

  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;background:${EMAIL_COLORS.surface};color:${EMAIL_COLORS.navy};font-family:${EMAIL_FONT_STACK};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
    <div style="max-width:620px;margin:0 auto;padding:28px 18px;">
      ${emailBrandHeaderHtml()}
      <div style="background:#fff;border:1px solid ${EMAIL_COLORS.lineWarm};border-radius:10px;padding:24px;">
        <p style="margin:0 0 8px;font-size:16px;">Bonjour,</p>
        <p style="margin:0 0 18px;color:${EMAIL_COLORS.inkStrong};">${escapeHtml(intro)}</p>
        ${sections}
        ${
          hiddenCount > 0
            ? `<p style="margin:0 0 16px;"><a href="${escapeAttribute(hiddenLink.url)}" style="color:${EMAIL_COLORS.navy};font-weight:700;">${escapeHtml(hiddenLink.label)}</a></p>`
            : ""
        }
        <p style="margin:12px 0 0;color:${EMAIL_COLORS.inkSoft};font-size:12px;line-height:1.5;">${escapeHtml(disclaimer)}</p>
        ${
          rentNotice
            ? `<p style="margin:8px 0 0;color:${EMAIL_COLORS.inkSoft};font-size:12px;line-height:1.5;">${escapeHtml(rentNotice)} <a href="${escapeAttribute(RENT_SOURCE_URL)}" style="color:${EMAIL_COLORS.inkSoft};">Source : data.gouv.fr</a></p>`
            : ""
        }
      </div>
      <p style="margin:14px 0 0;text-align:center;color:${EMAIL_COLORS.inkSoft};font-size:12px;line-height:1.5;">${escapeHtml(receptionReason)}</p>
      <p style="margin:8px 0 0;text-align:center;color:${EMAIL_COLORS.inkSoft};font-size:12px;">
        <a href="${escapeAttribute(alertsUrl)}" style="color:${EMAIL_COLORS.inkSoft};">Gérer mes alertes</a> ·
        <a href="${escapeAttribute(unsubscribeUrl)}" style="color:${EMAIL_COLORS.inkSoft};">Se désinscrire des alertes email</a>
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
