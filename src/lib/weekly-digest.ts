import "server-only";
import { errorDetailForLog } from "@/lib/api-errors";
import { resolveEmailAlertDeliveryConfig, sendResendEmail } from "@/lib/email-alerts";
import { weeklyDigestMode, type EmailFeatureMode } from "@/lib/email-feature-mode";
import { recentSaleChanges, type SaleChangeTopic } from "@/lib/sale-change-display";
import type { SaleChangeEventSummary } from "@/lib/sale-change-monitor";
import type { SaleCalendarRow } from "@/lib/sale-calendar";
import { calendarDaysBetween, nextParisMidnight, parisDateKey } from "@/lib/sale-countdown";
import {
  isSourceCheckStale,
  publicLocation,
  publicTitle,
  rotateRecipients,
  weekdayLongDate,
  type FollowedSale,
} from "@/lib/sale-reminders";
import { saleHearingTime, seoPropertyLabel } from "@/lib/seo";
import {
  buildWeeklyDigestMessage,
  weeklyDigestIsEmpty,
  type WeeklyDigestContent,
  type WeeklyDigestSaleItem,
} from "@/lib/weekly-digest-emails";

/**
 * Récapitulatif hebdomadaire « Ma semaine » : un seul email par semaine et par compte, envoyé par le
 * cron `weekly-digest` au jour choisi par le compte (le mardi par défaut).
 *
 * Règles (décisions du propriétaire du 20/10/2026) :
 * - consentement distinct (`weekly_digest_enabled`), jamais pré-coché, prouvé par la base (date et
 *   version du texte) ; interrupteur `WEEKLY_DIGEST_MODE` : `off` (défaut) n'envoie rien, `internal`
 *   n'écrit qu'aux administrateurs, `on` à toutes les personnes ayant consenti ;
 * - trois rubriques, les vides omises ; pas de rubrique, pas d'email (rien n'est envoyé « pour rien ») ;
 * - audiences : seulement les dates que la base juge sourcées (`get_public_sale_calendar_event`),
 *   revérifiées à la source depuis moins de 36 h, avec la mention « à vérifier auprès de l'avocat
 *   poursuivant » ; changements : libellés sans montant ni date ; nouvelles ventes : celles du
 *   département des alertes du compte (le profil n'a pas de département) ;
 * - AU PLUS UN EMAIL PAR COMPTE ET PAR JOUR. Règle de coexistence avec les autres emails : le
 *   récapitulatif passe en dernier (cron de 11:30 UTC, après les alertes, les rappels et les alertes de
 *   résultat). Si un autre email d'Immojudis est déjà parti ce jour-là au compte (récapitulatif
 *   d'alertes, rappel, alerte de résultat), le récapitulatif n'est PAS fusionné avec lui : il est
 *   reporté au lendemain, puis au surlendemain, et la semaine est sautée au-delà (MAX_DEFERRAL_DAYS) ;
 * - un récapitulatif n'est jamais envoyé deux fois pour la même semaine ISO : il est réservé dans
 *   `weekly_digest_dispatches` (unique par compte et semaine) avant l'envoi.
 */

/** Jours suivant le jour choisi pendant lesquels un envoi reporté reste dû. */
export const MAX_DEFERRAL_DAYS = 2;
/** Fenêtre des audiences annoncées. */
export const AUDIENCE_WINDOW_DAYS = 14;
/** Les changements et les nouvelles ventes plus anciens ne sont pas repris. */
export const LOOKBACK_DAYS = 7;
/** Éléments listés par rubrique : au-delà, « … et N autres » et le lien vers « Mes favoris ». */
export const MAX_AUDIENCES = 10;
export const MAX_CHANGES = 10;
export const MAX_NEW_SALES = 5;
/** Ventes dont la date est lue à la base par personne (une lecture publique chacune). */
const MAX_EXAMINED_SALES = 30;
/** Départements d'alertes pris en compte par personne. */
const MAX_DEPARTMENTS = 3;
const DAY_MS = 86_400_000;
const PROCESSING_BUDGET_MS = 50_000;
const USER_CONCURRENCY = 4;
/** Les changements montrent seulement leur libellé : jamais de montant ni de date (voir la fiche). */
const MASKED_TOPICS: ReadonlySet<SaleChangeTopic> = new Set<SaleChangeTopic>(["price", "date"]);

// -- Calendrier ---------------------------------------------------------------------------------------

function addDays(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Jour de la semaine d'un jour civil (AAAA-MM-JJ), ISO 8601 : 1 = lundi ... 7 = dimanche. */
export function isoWeekday(dayKey: string): number {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
}

/** Semaine ISO d'un jour civil, « AAAA-Www » (le jeudi de la semaine donne l'année). */
export function isoWeekKey(dayKey: string): string {
  const thursday = addDays(dayKey, 4 - isoWeekday(dayKey));
  const [year] = thursday.split("-").map(Number);
  const yearStart = `${year}-01-01`;
  const week = Math.floor((calendarDaysBetween(yearStart, thursday) ?? 0) / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * L'envoi dû aujourd'hui pour un jour choisi, ou `null`. Le jour choisi lui-même (`lag` 0), puis les
 * `MAX_DEFERRAL_DAYS` jours suivants pour un envoi reporté. La semaine ISO est celle du jour choisi :
 * un envoi reporté ne change pas de semaine de journal.
 */
export function dueDigest(
  weekday: number,
  now: Date,
): { dueDay: string; weekKey: string; lag: number } | null {
  const today = parisDateKey(now);
  const lag = (isoWeekday(today) - weekday + 7) % 7;
  if (lag > MAX_DEFERRAL_DAYS) return null;
  const dueDay = addDays(today, -lag);
  return { dueDay, weekKey: isoWeekKey(dueDay), lag };
}

/** Début du jour civil courant à Paris : sert à savoir si un email est déjà parti aujourd'hui. */
export function parisDayStart(now: Date): Date {
  return nextParisMidnight(addDays(parisDateKey(now), -1));
}

// -- Accès aux données ---------------------------------------------------------------------------------

export type WeeklyDigestSettings = { userId: string; weekday: number };

export type NewSaleSummary = {
  id: string;
  propertyType: string | null;
  city: string | null;
  department: string | null;
};

/** Accès aux données : réel en production (`weekly-digest-store.ts`), simulé dans les tests. */
export interface WeeklyDigestStore {
  /** Comptes ayant un consentement actif, daté et versionné, avec leur jour choisi. */
  listConsentingUsers(): Promise<WeeklyDigestSettings[]>;
  /** Parmi ces comptes, les administrateurs (mode `internal`). */
  filterAdminUserIds(userIds: string[]): Promise<Set<string>>;
  /**
   * Parmi ces comptes, ceux auxquels un autre email d'Immojudis (récapitulatif d'alertes, rappel
   * d'audience, alerte de résultat) est parti depuis `since`.
   */
  usersEmailedSince(userIds: string[], since: Date): Promise<Set<string>>;
  /** Clés `compte|semaine` dont le récapitulatif est déjà envoyé ou a épuisé ses essais. */
  settledDigests(entries: Array<{ userId: string; weekKey: string }>): Promise<Set<string>>;
  /** Favoris et ventes débloquées, avec leur date d'audience stockée. */
  followedSales(userId: string): Promise<FollowedSale[]>;
  /** Dernière vérification de chaque vente à la source, `null` quand elle est inconnue. */
  lastVerifiedAt(saleIds: string[]): Promise<Map<string, string | null>>;
  /** Ventes publiquement visibles (hors quarantaine). */
  visibleSaleIds(saleIds: string[]): Promise<Set<string>>;
  /** Faits publics de la date d'audience d'une vente (`get_public_sale_calendar_event`). */
  calendarEvent(saleId: string): Promise<SaleCalendarRow | null>;
  /** Tous les événements de changement détectés depuis `since` sur ces ventes, non masqués. */
  recentChangeEvents(
    userId: string,
    saleIds: string[],
    since: Date,
  ): Promise<SaleChangeEventSummary[]>;
  /** Les alertes actives du compte : en existe-t-il, et dans quels départements. */
  alertScope(userId: string): Promise<{ hasActiveAlert: boolean; departments: string[] }>;
  /** Ventes publiées depuis `since` dans ces départements, les plus récentes d'abord. */
  newSalesIn(
    departments: string[],
    since: Date,
    limit: number,
  ): Promise<{ total: number; sales: NewSaleSummary[] }>;
  /** Réserve le récapitulatif : l'identifiant de la ligne du journal, ou `null` s'il est déjà traité. */
  claim(args: {
    userId: string;
    weekKey: string;
    mode: Exclude<EmailFeatureMode, "off">;
    payload: Record<string, unknown>;
  }): Promise<string | null>;
  markSent(id: string, args: { messageId: string | null; at: Date }): Promise<void>;
  markFailed(id: string, args: { error: WeeklyDigestFailureCode }): Promise<void>;
  userEmail(userId: string): Promise<string | null>;
}

/** Raison courte d'un envoi en échec, conservée au journal à la place du texte d'erreur. */
export const WEEKLY_DIGEST_FAILURE_CODES = [
  "email_unavailable",
  "email_lookup_failed",
  "message_build_failed",
  "send_failed",
  "journal_failed",
] as const;
export type WeeklyDigestFailureCode = (typeof WEEKLY_DIGEST_FAILURE_CODES)[number];

// -- Contenu ----------------------------------------------------------------------------------------------

/**
 * L'audience à venir d'une date sourcée, ou `null` : date de la base (exportable, à venir), dans les
 * `AUDIENCE_WINDOW_DAYS` jours. Une audience sans heure connue se dit sans heure, jamais inventée.
 */
export function upcomingAudienceFor(
  row: SaleCalendarRow,
  now: Date,
): { saleDate: string; item: WeeklyDigestSaleItem } | null {
  if (!row.exportable || !row.sale_date) return null;
  const hearing = new Date(row.sale_date);
  if (!Number.isFinite(hearing.getTime())) return null;
  const days = calendarDaysBetween(parisDateKey(now), parisDateKey(hearing));
  if (days == null || days < 0 || days > AUDIENCE_WINDOW_DAYS) return null;
  const dateText = weekdayLongDate(row.sale_date);
  if (!dateText) return null;
  const time = row.date_only === false ? saleHearingTime(row.sale_date) : null;
  return {
    saleDate: row.sale_date,
    item: {
      saleId: row.id,
      title: publicTitle(row),
      location: publicLocation(row),
      detail: `Audience : ${dateText}${time ? ` à ${time}` : ""}`,
    },
  };
}

export type WeeklyDigestStats = {
  /** Audiences à annoncer écartées faute de vérification récente à la source. */
  skippedStale: number;
};

/** Le contenu du récapitulatif d'un compte, ou ses rubriques vides (`weeklyDigestIsEmpty`). */
export async function buildDigestContent({
  store,
  userId,
  now,
  stats,
}: {
  store: WeeklyDigestStore;
  userId: string;
  now: Date;
  stats?: WeeklyDigestStats;
}): Promise<WeeklyDigestContent> {
  const followed = await store.followedSales(userId);
  const visible = followed.length
    ? await store.visibleSaleIds(followed.map((sale) => sale.id))
    : new Set<string>();
  const followedVisible = followed.filter((sale) => visible.has(sale.id));

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

  // 1. Audiences des 14 prochains jours : la date stockée tombe dans la fenêtre, puis la base confirme
  // que la date est sourcée et que la vente a été revérifiée à la source récemment.
  const todayKey = parisDateKey(now);
  const inWindow: Array<{ sale: FollowedSale; days: number }> = [];
  for (const sale of followedVisible) {
    if (!sale.saleDate) continue;
    const stored = new Date(sale.saleDate);
    if (!Number.isFinite(stored.getTime())) continue;
    const days = calendarDaysBetween(todayKey, parisDateKey(stored));
    if (days == null || days < 0 || days > AUDIENCE_WINDOW_DAYS) continue;
    inWindow.push({ sale, days });
  }
  inWindow.sort((a, b) => a.days - b.days || a.sale.id.localeCompare(b.sale.id));
  const examined = inWindow.slice(0, MAX_EXAMINED_SALES).map(({ sale }) => sale);
  const verifiedAt = examined.length
    ? await store.lastVerifiedAt(examined.map((sale) => sale.id))
    : new Map<string, string | null>();
  const audiences: Array<{ saleDate: string; item: WeeklyDigestSaleItem }> = [];
  for (const sale of examined) {
    const row = await calendarOf(sale.id);
    const upcoming = row ? upcomingAudienceFor(row, now) : null;
    if (!upcoming) continue;
    if (isSourceCheckStale(verifiedAt.get(sale.id) ?? null, now)) {
      if (stats) stats.skippedStale += 1;
      continue;
    }
    audiences.push(upcoming);
  }
  audiences.sort(
    (a, b) =>
      Date.parse(a.saleDate) - Date.parse(b.saleDate) || a.item.saleId.localeCompare(b.item.saleId),
  );

  // 2. Changements des 7 derniers jours sur les ventes suivies : les libellés de « Mes favoris »
  // (`FavoriteSaleChanges`), sans montant ni date.
  const since = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS);
  const events = followedVisible.length
    ? await store.recentChangeEvents(
        userId,
        followedVisible.map((sale) => sale.id),
        since,
      )
    : [];
  const changed = recentSaleChanges(
    events.filter((event) => Date.parse(event.detectedAt) >= since.getTime()),
    new Set(followedVisible.map((sale) => sale.id)),
    { now, hiddenTopics: () => MASKED_TOPICS },
  );
  const changes: WeeklyDigestSaleItem[] = [];
  for (const change of changed.slice(0, MAX_CHANGES)) {
    const row = await calendarOf(change.event.saleId);
    changes.push({
      saleId: change.event.saleId,
      title: publicTitle(row),
      location: publicLocation(row),
      label: change.label,
      detail: change.detail,
    });
  }

  // 3. Nouvelles ventes du département des alertes. Sans alerte : le bouton « Créer une alerte ».
  const scope = await store.alertScope(userId);
  const departments = [...new Set(scope.departments)].slice(0, MAX_DEPARTMENTS);
  let newSalesTotal = 0;
  const newSaleItems: WeeklyDigestSaleItem[] = [];
  if (departments.length) {
    const found = await store.newSalesIn(departments, since, MAX_NEW_SALES);
    newSalesTotal = found.total;
    for (const sale of found.sales.slice(0, MAX_NEW_SALES)) {
      newSaleItems.push({
        saleId: sale.id,
        title: `${seoPropertyLabel(sale.propertyType)}${sale.city ? ` à ${sale.city}` : ""}`,
        location: sale.department ? `Département ${sale.department}` : "",
        detail: null,
      });
    }
  }

  return {
    audiences: audiences.slice(0, MAX_AUDIENCES).map(({ item }) => item),
    audiencesMore: Math.max(0, audiences.length - MAX_AUDIENCES),
    changes,
    changesMore: Math.max(0, changed.length - MAX_CHANGES),
    newSales: { departments, total: newSalesTotal, items: newSaleItems },
    hasAlert: scope.hasActiveAlert,
  };
}

// -- Passage ------------------------------------------------------------------------------------------------

export type WeeklyDigestRunSummary = {
  mode: EmailFeatureMode;
  /** Vrai quand l'envoi d'emails est configuré (clé Resend, expéditeur, adresse du site). */
  configured: boolean;
  /** Variables d'envoi manquantes quand l'envoi n'est pas configuré. */
  missingConfig: string[];
  consentingUsers: number;
  recipients: number;
  /** Récapitulatifs dus aujourd'hui (jour choisi ou report), pas encore envoyés pour la semaine. */
  due: number;
  /** Reportés parce qu'un autre email d'Immojudis est déjà parti aujourd'hui au compte. */
  deferredSameDay: number;
  /** Rien à annoncer cette semaine : aucun email. */
  skippedEmpty: number;
  /** Déjà réservés au journal par un autre passage. */
  alreadyClaimed: number;
  /** Audiences écartées faute de vérification récente à la source. */
  skippedStale: number;
  emailsSent: number;
  emailsFailed: number;
  /** Vrai quand le temps imparti s'est écoulé avant la fin : le passage doit être rejoué. */
  truncated: boolean;
  skipped: "off" | null;
};

function emptySummary(mode: EmailFeatureMode): WeeklyDigestRunSummary {
  return {
    mode,
    configured: false,
    missingConfig: [],
    consentingUsers: 0,
    recipients: 0,
    due: 0,
    deferredSameDay: 0,
    skippedEmpty: 0,
    alreadyClaimed: 0,
    skippedStale: 0,
    emailsSent: 0,
    emailsFailed: 0,
    truncated: false,
    skipped: null,
  };
}

/**
 * Fait échouer le passage quand un envoi est dû et ne peut pas partir : Resend non configuré (comme
 * `assertAlertNotificationDispatchComplete`), temps écoulé ou envois refusés. `runMonitoredCron` le
 * note en échec ; les lignes `failed` (moins de trois essais) sont reprises le lendemain tant que
 * l'envoi reste dû (MAX_DEFERRAL_DAYS).
 */
export function assertWeeklyDigestComplete(summary: WeeklyDigestRunSummary): void {
  if (summary.skipped === "off") return;
  if (!summary.configured && summary.due > 0) {
    const missing = summary.missingConfig.length
      ? ` (variable(s) manquante(s) : ${summary.missingConfig.join(", ")})`
      : "";
    throw new Error(
      `Récapitulatif hebdomadaire : ${summary.due} envoi(s) dû(s) mais l'envoi d'e-mails n'est pas configuré${missing}.`,
    );
  }
  const problems = [
    summary.truncated ? "passage interrompu par le délai imparti" : null,
    summary.emailsFailed > 0 ? `${summary.emailsFailed} envoi(s) en échec` : null,
  ].filter((problem): problem is string => problem !== null);
  if (problems.length) {
    throw new Error(
      `Récapitulatif hebdomadaire incomplet : ${problems.join(", ")} (${summary.emailsSent} email(s) envoyé(s)).`,
    );
  }
}

/**
 * Passage quotidien du cron `weekly-digest`. En mode `off` il ne lit rien et ne touche à rien. En
 * `internal` seuls les administrateurs ayant consenti reçoivent l'email (objet préfixé « [Test
 * interne] »).
 */
export async function runWeeklyDigest({
  store,
  now = new Date(),
  env = process.env,
  fetchImpl = fetch,
  mode = weeklyDigestMode(env),
}: {
  store: WeeklyDigestStore;
  now?: Date;
  env?: Pick<NodeJS.ProcessEnv, string>;
  fetchImpl?: typeof fetch;
  mode?: EmailFeatureMode;
}): Promise<WeeklyDigestRunSummary> {
  const summary = emptySummary(mode);
  if (mode === "off") return { ...summary, skipped: "off" };
  const sendMode: "internal" | "on" = mode;

  const consenting = await store.listConsentingUsers();
  summary.consentingUsers = consenting.length;
  let eligible = consenting;
  if (mode === "internal" && consenting.length) {
    const admins = await store.filterAdminUserIds(consenting.map(({ userId }) => userId));
    eligible = consenting.filter(({ userId }) => admins.has(userId));
  }
  summary.recipients = eligible.length;

  // Qui est dû aujourd'hui (jour choisi ou report), et pas déjà servi pour la semaine.
  const dueToday = eligible.flatMap((settings) => {
    const due = dueDigest(settings.weekday, now);
    return due ? [{ userId: settings.userId, weekKey: due.weekKey }] : [];
  });
  const settled = dueToday.length ? await store.settledDigests(dueToday) : new Set<string>();
  const pending = dueToday.filter(({ userId, weekKey }) => !settled.has(`${userId}|${weekKey}`));
  summary.due = pending.length;

  const config = resolveEmailAlertDeliveryConfig(env);
  if (!config.configured || !config.apiKey || !config.from || !config.appUrl) {
    summary.missingConfig = config.missing;
    return summary;
  }
  summary.configured = true;
  if (!pending.length) return summary;
  const { apiKey, from, appUrl } = config;

  // Au plus un email par compte et par jour : un autre email déjà parti aujourd'hui reporte le
  // récapitulatif au lendemain (voir l'en-tête du fichier).
  const emailedToday = await store.usersEmailedSince(
    pending.map(({ userId }) => userId),
    parisDayStart(now),
  );
  const weekKeyOf = new Map(pending.map(({ userId, weekKey }) => [userId, weekKey]));
  const sendable = pending.filter(({ userId }) => !emailedToday.has(userId));
  summary.deferredSameDay = pending.length - sendable.length;
  const recipients = rotateRecipients(
    sendable.map(({ userId }) => userId),
    now,
  );

  const deadline = Date.now() + PROCESSING_BUDGET_MS;
  async function processUser(userId: string) {
    const weekKey = weekKeyOf.get(userId) as string;
    const content = await buildDigestContent({ store, userId, now, stats: summary });
    if (weeklyDigestIsEmpty(content)) {
      summary.skippedEmpty += 1;
      return;
    }
    const id = await store.claim({
      userId,
      weekKey,
      mode: sendMode,
      payload: {
        audiences: content.audiences.length + content.audiencesMore,
        changes: content.changes.length + content.changesMore,
        newSales: content.newSales.total,
        hasAlert: content.hasAlert,
      },
    });
    if (!id) {
      summary.alreadyClaimed += 1;
      return;
    }

    // Un échec ne garde au journal qu'un code court : le détail va aux journaux d'exécution, jamais
    // dans la base.
    const fail = async (code: WeeklyDigestFailureCode, error?: unknown) => {
      console.error(
        JSON.stringify({
          scope: "weekly-digest.failure",
          code,
          ...(error === undefined ? {} : { detail: errorDetailForLog(error).slice(0, 200) }),
        }),
      );
      await store.markFailed(id, { error: code });
      summary.emailsFailed += 1;
    };

    let recipient: string | null;
    try {
      recipient = await store.userEmail(userId);
    } catch (error) {
      await fail("email_lookup_failed", error);
      return;
    }
    if (!recipient) {
      // `readUserEmail` rend aussi `null` pour une adresse non confirmée.
      await fail("email_unavailable");
      return;
    }

    let stage: WeeklyDigestFailureCode = "message_build_failed";
    try {
      const message = buildWeeklyDigestMessage({
        userId,
        content,
        recipientEmail: recipient,
        from,
        appUrl,
        internal: sendMode === "internal",
        now,
        env,
      });
      stage = "send_failed";
      const result = await sendResendEmail({
        apiKey,
        message,
        idempotencyKey: `immojudis-weekly-digest-${userId}-${weekKey}`,
        fetchImpl,
      });
      stage = "journal_failed";
      await store.markSent(id, { messageId: result.id, at: new Date() });
      summary.emailsSent += 1;
    } catch (error) {
      await fail(stage, error);
    }
  }

  for (let index = 0; index < recipients.length; index += USER_CONCURRENCY) {
    if (Date.now() > deadline) {
      summary.truncated = true;
      break;
    }
    const batch = recipients.slice(index, index + USER_CONCURRENCY);
    const settledBatch = await Promise.allSettled(batch.map((userId) => processUser(userId)));
    const failure = settledBatch.find((result) => result.status === "rejected");
    if (failure && failure.status === "rejected") {
      // Une erreur de lecture (base injoignable) n'est pas une absence de contenu : le passage échoue
      // pour être vu et rejoué, le journal empêchant tout doublon.
      throw failure.reason instanceof Error
        ? failure.reason
        : new Error("Récapitulatif hebdomadaire : lecture impossible.");
    }
  }
  return summary;
}
