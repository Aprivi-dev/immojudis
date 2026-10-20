import "server-only";
import { createHash } from "node:crypto";
import { resolveEmailAlertDeliveryConfig, sendResendEmail } from "@/lib/email-alerts";
import { describeSaleChange, GRAVE_SALE_STATUSES } from "@/lib/sale-change-display";
import type { SaleChangeEventSummary } from "@/lib/sale-change-monitor";
import { SALE_CALENDAR_DISCLAIMER, type SaleCalendarRow } from "@/lib/sale-calendar";
import { calendarDaysBetween, parisDateKey } from "@/lib/sale-countdown";
import {
  buildSaleReminderMessage,
  type SaleReminderItem,
  type SaleReminderKind,
} from "@/lib/sale-reminder-emails";
import { saleRemindersMode, type SaleRemindersMode } from "@/lib/sale-reminders-mode";
import { saleHearingTime, seoPropertyLabel, tribunalDisplayName } from "@/lib/seo";

/**
 * Rappels d'audience (J-7, J-1) et avertissements graves sur les ventes qu'une personne suit
 * (favoris et ventes débloquées), envoyés une fois par jour par le cron `sale-reminders`.
 *
 * Règles (décisions du propriétaire du 19/10/2026) :
 * - consentement distinct, jamais pré-coché, retirable (voir `notification-preferences.ts`) ;
 * - `SALE_REMINDERS_MODE` : `off` (défaut) n'envoie rien, `internal` n'écrit qu'aux administrateurs,
 *   `on` à toutes les personnes ayant consenti ;
 * - une date n'est annoncée que si la base la juge sourcée (`get_public_sale_calendar_event` :
 *   audience au tribunal, à venir, ni reportée ni contradictoire), avec la mention « à vérifier
 *   auprès de l'avocat poursuivant » ;
 * - les avertissements se limitent aux cas graves lus dans les événements du suivi des changements
 *   (`audience_changed`, `status_changed`) : date modifiée, vente retirée, reportée ou adjugée ;
 * - un rappel n'est jamais envoyé deux fois : il est réservé dans `sale_reminder_dispatches`
 *   (clé unique) avant l'envoi.
 */

/** Jours avant l'audience auxquels on rappelle. */
const REMINDER_DAYS: ReadonlyArray<{ days: number; kind: "audience_j7" | "audience_j1" }> = [
  { days: 7, kind: "audience_j7" },
  { days: 1, kind: "audience_j1" },
];

/** Les événements de changement plus anciens ne sont plus relus (le cron passe chaque jour). */
export const WARNING_LOOKBACK_HOURS = 72;
/** Au plus ce nombre d'éléments par email : au-delà, un second email part (rien n'est perdu). */
export const MAX_REMINDER_ITEMS_PER_EMAIL = 10;
/**
 * Au plus ce nombre d'emails par personne et par passage. Un reste éventuel (de quoi dépasser
 * 50 éléments) fait échouer le passage : le rattrapage de 09:15 envoie la suite.
 */
export const MAX_EMAILS_PER_USER = 5;
const DAY_MS = 86_400_000;
/** Pas du décalage quotidien de l'ordre de départ (nombre d'or : les points de départ tournent). */
const START_ROTATION_STEP = 0.6180339887498949;
/** Au plus ce nombre de ventes suivies examinées par personne. */
const MAX_FOLLOWED_SALES_PER_USER = 300;
const PROCESSING_BUDGET_MS = 50_000;
const USER_CONCURRENCY = 4;
const PARIS_TIME_ZONE = "Europe/Paris";
const DATE_TO_CONFIRM = "Nouvelle date à confirmer auprès de l’avocat poursuivant.";

export type FollowedSale = { id: string; saleDate: string | null };

/** Accès aux données : réel en production (`sale-reminders-store.ts`), simulé dans les tests. */
export interface SaleReminderStore {
  /** Personnes ayant un consentement actif et daté aux rappels. */
  listConsentingUserIds(): Promise<string[]>;
  /** Parmi ces personnes, les administrateurs (mode `internal`). */
  filterAdminUserIds(userIds: string[]): Promise<Set<string>>;
  /** Favoris et ventes débloquées, avec leur date d'audience stockée. */
  followedSales(userId: string): Promise<FollowedSale[]>;
  /** Ventes publiquement visibles (hors quarantaine). */
  visibleSaleIds(saleIds: string[]): Promise<Set<string>>;
  /** Faits publics de la date d'audience d'une vente (`get_public_sale_calendar_event`). */
  calendarEvent(saleId: string): Promise<SaleCalendarRow | null>;
  /** Événements de changement détectés depuis `since` sur ces ventes, non masqués. */
  recentChangeEvents(
    userId: string,
    saleIds: string[],
    since: Date,
  ): Promise<SaleChangeEventSummary[]>;
  /** Réserve un rappel : l'identifiant de la ligne du journal, ou `null` s'il a déjà été traité. */
  claim(args: {
    userId: string;
    saleId: string;
    kind: SaleReminderKind;
    dedupeKey: string;
    mode: Exclude<SaleRemindersMode, "off">;
    payload: Record<string, unknown>;
  }): Promise<string | null>;
  markSent(ids: string[], args: { messageId: string | null; at: Date }): Promise<void>;
  markFailed(ids: string[], args: { error: string }): Promise<void>;
  userEmail(userId: string): Promise<string | null>;
  /** Purge les lignes anciennes du journal ; renvoie leur nombre. */
  purgeJournal(): Promise<number>;
}

export type SaleReminderRunSummary = {
  mode: SaleRemindersMode;
  /** Vrai quand l'envoi d'emails est configuré (clé Resend, expéditeur, adresse du site). */
  configured: boolean;
  consentingUsers: number;
  recipients: number;
  /** Rappels détectés avant le dédoublonnage du journal. */
  candidates: number;
  /** Rappels réservés au journal, donc à envoyer (les autres l'avaient déjà été). */
  claimed: number;
  emailsSent: number;
  emailsFailed: number;
  /** Rappels envoyés, par motif. */
  sentByKind: Record<SaleReminderKind, number>;
  purgedJournalRows: number;
  /** Vrai quand le temps imparti s'est écoulé avant la fin : le passage doit être rejoué. */
  truncated: boolean;
  /** Éléments détectés mais non réservés faute de place (plus de 50 pour une personne). */
  deferred: number;
  skipped: "off" | "not_configured" | null;
};

function emptySummary(mode: SaleRemindersMode): SaleReminderRunSummary {
  return {
    mode,
    configured: false,
    consentingUsers: 0,
    recipients: 0,
    candidates: 0,
    claimed: 0,
    emailsSent: 0,
    emailsFailed: 0,
    sentByKind: { audience_j7: 0, audience_j1: 0, date_changed: 0, status_changed: 0 },
    purgedJournalRows: 0,
    truncated: false,
    deferred: 0,
    skipped: null,
  };
}

export type DetectedReminder = {
  kind: SaleReminderKind;
  saleId: string;
  dedupeKey: string;
  item: SaleReminderItem;
  /** Ce qui est annoncé, conservé au journal pour mesurer les fausses alertes. */
  payload: Record<string, unknown>;
};

const KIND_PRIORITY: Record<SaleReminderKind, number> = {
  status_changed: 0,
  date_changed: 1,
  audience_j1: 2,
  audience_j7: 3,
};

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function weekdayLongDate(value: string): string | null {
  const date = parseDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: PARIS_TIME_ZONE,
  }).format(date);
}

/** « Maison à Bordeaux » : le type de bien et la commune publics, jamais l'adresse. */
function publicTitle(row: Pick<SaleCalendarRow, "property_type" | "city"> | null): string {
  if (!row) return "Vente suivie";
  const city = row.city?.replace(/\s+/g, " ").trim();
  return `${seoPropertyLabel(row.property_type)}${city ? ` à ${city}` : ""}`;
}

function publicLocation(
  row: Pick<SaleCalendarRow, "tribunal_name" | "tribunal_city"> | null,
): string {
  if (!row) return "";
  return (
    tribunalDisplayName({ tribunal_name: row.tribunal_name, tribunal_city: row.tribunal_city }) ??
    ""
  );
}

/**
 * Le rappel d'audience du jour pour une date sourcée, ou `null`. Aujourd'hui et le jour de
 * l'audience sont comparés en jours civils de Paris : une audience sans heure connue se rappelle
 * comme les autres, sans heure inventée.
 */
export function audienceReminderFor(
  row: SaleCalendarRow,
  now: Date,
): { kind: "audience_j7" | "audience_j1"; dayKey: string; item: SaleReminderItem } | null {
  if (!row.exportable || !row.sale_date) return null;
  const hearing = parseDate(row.sale_date);
  if (!hearing) return null;
  const dayKey = parisDateKey(hearing);
  const days = calendarDaysBetween(parisDateKey(now), dayKey);
  const match = REMINDER_DAYS.find((reminder) => reminder.days === days);
  const dateText = weekdayLongDate(row.sale_date);
  if (!match || !dateText) return null;
  const time = row.date_only === false ? saleHearingTime(row.sale_date) : null;
  return {
    kind: match.kind,
    dayKey,
    item: {
      kind: match.kind,
      saleId: row.id,
      title: publicTitle(row),
      location: publicLocation(row),
      headline: match.days === 1 ? "Votre audience est demain" : "Votre audience est dans 7 jours",
      detail: `Audience : ${dateText}${time ? ` à ${time}` : ""}`,
    },
  };
}

/**
 * L'avertissement grave d'un événement de changement, ou `null` :
 * - date d'audience modifiée vers un autre jour (pas un simple changement d'heure le même jour),
 *   qui n'est pas déjà passé ;
 * - statut passé à reportée, retirée, annulée ou adjugée.
 * Le prix, les documents et le score ne déclenchent jamais d'email.
 */
export function graveWarningFor(
  event: SaleChangeEventSummary,
  now: Date,
): { kind: "date_changed" | "status_changed"; headline: string } | null {
  const described = describeSaleChange(event);
  if (!described) return null;
  if (event.eventKind === "audience_changed") {
    const previous = parseDate(event.changeSummary.previousValue);
    const current = parseDate(event.changeSummary.currentValue);
    if (!previous || !current) return null;
    if (parisDateKey(previous) === parisDateKey(current)) return null;
    if (parisDateKey(current) < parisDateKey(now)) return null;
    return { kind: "date_changed", headline: "La date de l’audience a changé" };
  }
  if (event.eventKind === "status_changed") {
    const current = event.changeSummary.currentValue;
    if (typeof current !== "string" || !GRAVE_SALE_STATUSES.has(current.toLowerCase())) return null;
    return { kind: "status_changed", headline: described.label };
  }
  return null;
}

/** Ce qui est à rappeler à une personne aujourd'hui (avant le dédoublonnage du journal). */
export async function detectRemindersForUser({
  store,
  userId,
  now,
}: {
  store: SaleReminderStore;
  userId: string;
  now: Date;
}): Promise<DetectedReminder[]> {
  const followed = (await store.followedSales(userId)).slice(0, MAX_FOLLOWED_SALES_PER_USER);
  if (!followed.length) return [];
  const visible = await store.visibleSaleIds(followed.map((sale) => sale.id));
  const followedVisible = followed.filter((sale) => visible.has(sale.id));
  if (!followedVisible.length) return [];

  const detected = new Map<string, DetectedReminder>();
  const add = (reminder: DetectedReminder) => {
    const key = `${reminder.saleId}|${reminder.kind}|${reminder.dedupeKey}`;
    if (!detected.has(key)) detected.set(key, reminder);
  };
  // Une seule lecture de la date publique par vente et par passage.
  const calendarCache = new Map<string, Promise<SaleCalendarRow | null>>();
  const calendarOf = (saleId: string) => {
    let cached = calendarCache.get(saleId);
    if (!cached) {
      cached = store.calendarEvent(saleId);
      calendarCache.set(saleId, cached);
    }
    return cached;
  };

  // 1. Rappels d'audience : seulement les ventes dont la date stockée tombe dans la fenêtre, puis
  // la base confirme que la date est sourcée.
  const todayKey = parisDateKey(now);
  const maxDays = Math.max(...REMINDER_DAYS.map((reminder) => reminder.days));
  for (const sale of followedVisible) {
    const storedDate = parseDate(sale.saleDate);
    if (!storedDate) continue;
    const days = calendarDaysBetween(todayKey, parisDateKey(storedDate));
    if (days == null || days < 0 || days > maxDays) continue;
    const row = await calendarOf(sale.id);
    const reminder = row ? audienceReminderFor(row, now) : null;
    if (!reminder) continue;
    add({
      kind: reminder.kind,
      saleId: sale.id,
      dedupeKey: reminder.dayKey,
      item: reminder.item,
      payload: { headline: reminder.item.headline, detail: reminder.item.detail },
    });
  }

  // 2. Avertissements graves, lus dans les événements du suivi des changements.
  const since = new Date(now.getTime() - WARNING_LOOKBACK_HOURS * 3_600_000);
  const events = await store.recentChangeEvents(
    userId,
    followedVisible.map((sale) => sale.id),
    since,
  );
  for (const event of events) {
    const warning = graveWarningFor(event, now);
    if (!warning) continue;
    // Le type de bien, la commune et la nouvelle date viennent de la base publique : une date que
    // la base ne juge pas sourcée est annoncée « à confirmer », jamais recopiée.
    const row = await calendarOf(event.saleId);
    const newDate =
      warning.kind === "date_changed" && row?.exportable && row.sale_date
        ? weekdayLongDate(row.sale_date)
        : null;
    const detail =
      warning.kind === "date_changed"
        ? newDate
          ? `Nouvelle date : ${newDate}. ${SALE_CALENDAR_DISCLAIMER}`
          : DATE_TO_CONFIRM
        : warning.headline === "Vente reportée"
          ? DATE_TO_CONFIRM
          : "Statut à vérifier auprès de l’avocat poursuivant.";
    add({
      kind: warning.kind,
      saleId: event.saleId,
      dedupeKey: event.fingerprint,
      item: {
        kind: warning.kind,
        saleId: event.saleId,
        title: publicTitle(row),
        location: publicLocation(row),
        headline: warning.headline,
        detail,
      },
      payload: {
        headline: warning.headline,
        field: event.changeSummary.field ?? null,
        previousValue: event.changeSummary.previousValue ?? null,
        currentValue: event.changeSummary.currentValue ?? null,
        detectedAt: event.detectedAt,
      },
    });
  }

  return [...detected.values()].sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]);
}

/**
 * Ordre de traitement des personnes : trié, puis décalé d'un nombre qui dépend du jour (le
 * rattrapage part de l'autre moitié de l'anneau). Sans cela, une troncature par le délai écarterait
 * chaque jour les mêmes personnes, et le rattrapage referait le même travail avant d'arriver au même
 * endroit.
 */
export function rotateRecipients(userIds: readonly string[], now: Date, catchUp = false): string[] {
  const sorted = [...userIds].sort();
  if (sorted.length < 2) return sorted;
  const day = Math.floor(now.getTime() / DAY_MS);
  const base = Math.floor(sorted.length * ((day * START_ROTATION_STEP) % 1));
  const start = (base + (catchUp ? Math.floor(sorted.length / 2) : 0)) % sorted.length;
  return [...sorted.slice(start), ...sorted.slice(0, start)];
}

/**
 * Fait échouer le passage quand il n'a pas tout traité (temps écoulé, éléments non réservés ou
 * envois refusés) : `runMonitoredCron` le note en échec, donc le rattrapage de 09:15 s'exécute
 * et la supervision le voit. Les rappels déjà envoyés ne repartent pas (journal) ; les lignes
 * `failed` (moins de trois essais) et les `pending` orphelines de plus d'une heure sont reprises.
 */
export function assertSaleRemindersComplete(summary: SaleReminderRunSummary): void {
  const problems = [
    summary.truncated ? "passage interrompu par le délai imparti" : null,
    summary.emailsFailed > 0 ? `${summary.emailsFailed} envoi(s) en échec` : null,
    summary.deferred > 0 ? `${summary.deferred} rappel(s) non réservé(s) faute de place` : null,
  ].filter((problem): problem is string => problem !== null);
  if (problems.length) {
    throw new Error(
      `Rappels d'audience incomplets : ${problems.join(", ")} (${summary.emailsSent} email(s) envoyé(s)).`,
    );
  }
}

/**
 * Passage quotidien. En mode `off` il ne lit rien et ne touche à rien. En `internal` seuls les
 * administrateurs ayant consenti reçoivent les emails (objet préfixé « [Test interne] »).
 */
export async function runSaleReminders({
  store,
  now = new Date(),
  env = process.env,
  fetchImpl = fetch,
  mode = saleRemindersMode(env),
  catchUp = false,
}: {
  store: SaleReminderStore;
  now?: Date;
  env?: Pick<NodeJS.ProcessEnv, string>;
  fetchImpl?: typeof fetch;
  mode?: SaleRemindersMode;
  /** Passage de rattrapage (09:15) : il part de l'autre moitié de l'ordre des personnes. */
  catchUp?: boolean;
}): Promise<SaleReminderRunSummary> {
  const summary = emptySummary(mode);
  if (mode === "off") return { ...summary, skipped: "off" };

  const config = resolveEmailAlertDeliveryConfig(env);
  if (!config.configured || !config.apiKey || !config.from || !config.appUrl) {
    return { ...summary, skipped: "not_configured" };
  }
  summary.configured = true;
  const { apiKey, from, appUrl } = config;
  const sendMode: "internal" | "on" = mode;

  const consenting = await store.listConsentingUserIds();
  summary.consentingUsers = consenting.length;
  let recipients = consenting;
  if (mode === "internal" && consenting.length) {
    const admins = await store.filterAdminUserIds(consenting);
    recipients = consenting.filter((userId) => admins.has(userId));
  }
  summary.recipients = recipients.length;
  recipients = rotateRecipients(recipients, now, catchUp);

  const deadline = Date.now() + PROCESSING_BUDGET_MS;
  async function processUser(userId: string) {
    const detected = await detectRemindersForUser({ store, userId, now });
    summary.candidates += detected.length;
    if (!detected.length) return;

    // Réserve d'abord (le journal garantit qu'un rappel ne part jamais deux fois), dans l'ordre
    // d'urgence, dans la limite de MAX_EMAILS_PER_USER emails : le reste est compté et fait
    // échouer le passage, le rattrapage le réserve (les déjà réservés sont sautés).
    const maxItems = MAX_REMINDER_ITEMS_PER_EMAIL * MAX_EMAILS_PER_USER;
    const claimed: Array<{ reminder: DetectedReminder; id: string }> = [];
    let visited = 0;
    for (const reminder of detected) {
      if (claimed.length >= maxItems) break;
      visited += 1;
      const id = await store.claim({
        userId,
        saleId: reminder.saleId,
        kind: reminder.kind,
        dedupeKey: reminder.dedupeKey,
        mode: sendMode,
        payload: reminder.payload,
      });
      if (id) claimed.push({ reminder, id });
    }
    summary.deferred += detected.length - visited;
    summary.claimed += claimed.length;
    if (!claimed.length) return;
    const allIds = claimed.map(({ id }) => id);

    let recipient: string | null;
    try {
      recipient = await store.userEmail(userId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Adresse email illisible.";
      await store.markFailed(allIds, { error: detail.slice(0, 500) });
      summary.emailsFailed += 1;
      return;
    }
    if (!recipient) {
      await store.markFailed(allIds, {
        error: "Aucune adresse email authentifiée disponible pour cet utilisateur.",
      });
      summary.emailsFailed += 1;
      return;
    }

    // Un email par groupe de MAX_REMINDER_ITEMS_PER_EMAIL éléments, les plus urgents d'abord.
    for (let start = 0; start < claimed.length; start += MAX_REMINDER_ITEMS_PER_EMAIL) {
      const group = claimed.slice(start, start + MAX_REMINDER_ITEMS_PER_EMAIL);
      const ids = group.map(({ id }) => id);
      try {
        const message = buildSaleReminderMessage({
          userId,
          items: group.map(({ reminder }) => reminder.item),
          recipientEmail: recipient,
          from,
          appUrl,
          internal: sendMode === "internal",
          now,
          env,
        });
        const key = createHash("sha256")
          .update([...ids].sort().join(","))
          .digest("hex")
          .slice(0, 24);
        const result = await sendResendEmail({
          apiKey,
          message,
          idempotencyKey: `immojudis-sale-reminders-${userId}-${key}`,
          fetchImpl,
        });
        await store.markSent(ids, { messageId: result.id, at: new Date() });
        summary.emailsSent += 1;
        for (const { reminder } of group) summary.sentByKind[reminder.kind] += 1;
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Envoi email impossible.";
        await store.markFailed(ids, { error: detail.slice(0, 500) });
        summary.emailsFailed += 1;
      }
    }
  }

  for (let index = 0; index < recipients.length; index += USER_CONCURRENCY) {
    if (Date.now() > deadline) {
      summary.truncated = true;
      break;
    }
    const batch = recipients.slice(index, index + USER_CONCURRENCY);
    const settled = await Promise.allSettled(batch.map((userId) => processUser(userId)));
    const failure = settled.find((result) => result.status === "rejected");
    if (failure && failure.status === "rejected") {
      // Une erreur de lecture (base injoignable) n'est pas une absence de rappel : le passage
      // échoue pour être vu et rejoué, le journal empêchant tout doublon.
      throw failure.reason instanceof Error
        ? failure.reason
        : new Error("Rappels d'audience : lecture impossible.");
    }
  }

  summary.purgedJournalRows = await store.purgeJournal();
  return summary;
}
