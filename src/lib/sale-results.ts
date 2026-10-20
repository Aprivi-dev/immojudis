import "server-only";
import { createHash } from "node:crypto";
import { errorDetailForLog } from "@/lib/api-errors";
import { resolveEmailAlertDeliveryConfig, sendResendEmail } from "@/lib/email-alerts";
import { saleResultsMode, type EmailFeatureMode } from "@/lib/email-feature-mode";
import type { SaleChangeEventSummary } from "@/lib/sale-change-monitor";
import type { SaleCalendarRow } from "@/lib/sale-calendar";
import {
  publicLocation,
  publicTitle,
  rotateRecipients,
  type FollowedSale,
} from "@/lib/sale-reminders";
import {
  buildSaleResultMessage,
  SALE_RESULT_DETAILS,
  SALE_RESULT_HEADLINES,
  type SaleResultItem,
  type SaleResultKind,
} from "@/lib/sale-result-emails";
import { seoPropertyLabel, tribunalDisplayName } from "@/lib/seo";
import { surenchereWindow } from "@/lib/surenchere-window";

/**
 * Alerte de résultat ou de remise en vente d'une vente suivie (favoris et ventes débloquées),
 * envoyée une fois par jour par le cron `sale-results`.
 *
 * Règles (décisions du propriétaire du 20/10/2026) :
 * - consentement DISTINCT de celui des rappels d'audience (`sale_results_enabled`), jamais pré-coché,
 *   prouvé par la base (date et version du texte) ; interrupteur `SALE_RESULTS_MODE` : `off` (défaut)
 *   n'envoie rien, `internal` n'écrit qu'aux administrateurs, `on` à toutes les personnes ayant consenti ;
 * - JAMAIS DE PRIX dans l'email : les instantanés ne sont lus que sans leurs colonnes de prix ;
 * - deux sources : l'instantané gardé après l'audience (`user_followed_sale_snapshots` : « adjugée » ou
 *   « résultat inconnu », avec la mention de surenchère indicative) et les statuts graves du suivi des
 *   changements (`status_changed` : adjugée, retirée ou annulée, remise en vente) ;
 * - pas de type « non adjugée » : aucune source ne le prouve (un résultat inconnu n'est pas un échec de
 *   la vente) ;
 * - pas de doublon avec les rappels d'audience : quand le journal des rappels (`sale_reminder_dispatches`)
 *   a déjà annoncé le même statut grave (adjugée, retirée, annulée) pour cette vente, l'alerte de
 *   résultat ne le répète pas (le cron des résultats passe après celui des rappels) ;
 * - un email n'est jamais envoyé deux fois : il est réservé dans `sale_result_dispatches` (unique par
 *   compte, vente et type) avant l'envoi.
 */

/** Les instantanés plus anciens ne sont plus relus (le cron passe chaque jour). */
export const SNAPSHOT_LOOKBACK_DAYS = 7;
/** Les événements de changement plus anciens ne sont plus relus. */
export const STATUS_LOOKBACK_HOURS = 72;
/**
 * Au plus ce nombre d'éléments par email et par passage ; le reste est compté (`deferred`) et repris
 * au passage suivant tant que l'instantané ou l'événement est dans sa fenêtre de relecture.
 */
export const MAX_RESULT_ITEMS_PER_EMAIL = 10;
const PROCESSING_BUDGET_MS = 50_000;
const USER_CONCURRENCY = 4;
/** Statuts qui annoncent une remise en vente quand la vente repasse « à venir » depuis l'un d'eux. */
const RELIST_FROM = new Set(["past", "adjudicated", "withdrawn", "cancelled", "canceled"]);

export type FollowedSnapshot = {
  saleId: string;
  capturedAt: string;
  resultStatus: "adjudicated" | "unknown";
  saleDate: string | null;
  venueType: string | null;
  city: string | null;
  propertyType: string | null;
  tribunalName: string | null;
};

/** Accès aux données : réel en production (`sale-results-store.ts`), simulé dans les tests. */
export interface SaleResultStore {
  /** Comptes ayant un consentement actif, daté et versionné à l'alerte de résultat. */
  listConsentingUserIds(): Promise<string[]>;
  /** Parmi ces comptes, les administrateurs (mode `internal`). */
  filterAdminUserIds(userIds: string[]): Promise<Set<string>>;
  /** Favoris et ventes débloquées. */
  followedSales(userId: string): Promise<FollowedSale[]>;
  /** Ventes publiquement visibles (hors quarantaine). */
  visibleSaleIds(saleIds: string[]): Promise<Set<string>>;
  /** Faits publics d'une vente (`get_public_sale_calendar_event`), pour son titre. */
  calendarEvent(saleId: string): Promise<SaleCalendarRow | null>;
  /** Événements de changement détectés depuis `since` sur ces ventes, non masqués. */
  recentChangeEvents(
    userId: string,
    saleIds: string[],
    since: Date,
  ): Promise<SaleChangeEventSummary[]>;
  /** Instantanés après l'audience capturés depuis `since`, SANS aucune colonne de prix. */
  recentSnapshots(userId: string, since: Date): Promise<FollowedSnapshot[]>;
  /** Les rappels d'audience ont déjà annoncé ce statut grave pour cette vente (journal des rappels). */
  reminderWarningExists(userId: string, saleId: string, status: string): Promise<boolean>;
  /** Réserve une alerte : l'identifiant de la ligne du journal, ou `null` si elle a déjà été traitée. */
  claim(args: {
    userId: string;
    saleId: string;
    kind: SaleResultKind;
    mode: Exclude<EmailFeatureMode, "off">;
    payload: Record<string, unknown>;
  }): Promise<string | null>;
  markSent(ids: string[], args: { messageId: string | null; at: Date }): Promise<void>;
  markFailed(ids: string[], args: { error: SaleResultFailureCode }): Promise<void>;
  userEmail(userId: string): Promise<string | null>;
}

/** Raison courte d'un envoi en échec, conservée au journal à la place du texte d'erreur. */
export const SALE_RESULT_FAILURE_CODES = [
  "email_unavailable",
  "email_lookup_failed",
  "message_build_failed",
  "send_failed",
  "journal_failed",
] as const;
export type SaleResultFailureCode = (typeof SALE_RESULT_FAILURE_CODES)[number];

export type DetectedSaleResult = {
  kind: SaleResultKind;
  saleId: string;
  item: SaleResultItem;
  /** Ce qui est annoncé, conservé au journal : l'origine et le statut, jamais un prix. */
  payload: Record<string, unknown>;
};

const KIND_PRIORITY: Record<SaleResultKind, number> = {
  result_known: 0,
  result_unknown: 1,
  relisted: 2,
  withdrawn: 3,
};

function lowerString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

/**
 * Le type d'alerte d'un changement de statut, ou `null` :
 * - passé à « adjugée » : résultat connu ;
 * - passé à « retirée » ou « annulée » : retirée ou annulée ;
 * - revenu à « à venir » depuis passée, adjugée, retirée ou annulée : remise en vente (un report suivi
 *   d'une nouvelle date n'en est pas une : c'est un changement de date, annoncé par les rappels).
 */
export function saleResultKindFor(
  event: SaleChangeEventSummary,
): { kind: SaleResultKind; status: string } | null {
  if (event.eventKind !== "status_changed") return null;
  const current = lowerString(event.changeSummary.currentValue);
  const previous = lowerString(event.changeSummary.previousValue);
  if (!current) return null;
  if (current === "adjudicated") return { kind: "result_known", status: current };
  if (current === "withdrawn" || current === "cancelled" || current === "canceled") {
    return { kind: "withdrawn", status: current };
  }
  if (current === "upcoming" && previous && RELIST_FROM.has(previous)) {
    return { kind: "relisted", status: current };
  }
  return null;
}

export type SaleResultStats = {
  /** Alertes non envoyées parce que les rappels d'audience ont déjà annoncé le même statut. */
  skippedCovered: number;
};

/** Ce qui est à annoncer à une personne aujourd'hui (avant le dédoublonnage du journal). */
export async function detectSaleResultsForUser({
  store,
  userId,
  now,
  stats,
}: {
  store: SaleResultStore;
  userId: string;
  now: Date;
  stats?: SaleResultStats;
}): Promise<DetectedSaleResult[]> {
  const detected = new Map<string, DetectedSaleResult>();
  const add = (result: DetectedSaleResult) => {
    const key = `${result.saleId}|${result.kind}`;
    if (!detected.has(key)) detected.set(key, result);
  };
  const covered = async (saleId: string, status: string) => {
    if (!(await store.reminderWarningExists(userId, saleId, status))) return false;
    if (stats) stats.skippedCovered += 1;
    return true;
  };

  // 1. Instantanés après l'audience : la vente a eu lieu.
  const snapshots = await store.recentSnapshots(
    userId,
    new Date(now.getTime() - SNAPSHOT_LOOKBACK_DAYS * 86_400_000),
  );
  for (const snapshot of snapshots) {
    const adjudicated = snapshot.resultStatus === "adjudicated";
    const kind: SaleResultKind = adjudicated ? "result_known" : "result_unknown";
    if (adjudicated && (await covered(snapshot.saleId, "adjudicated"))) continue;
    const city = snapshot.city?.replace(/\s+/g, " ").trim();
    add({
      kind,
      saleId: snapshot.saleId,
      item: {
        kind,
        saleId: snapshot.saleId,
        title: `${seoPropertyLabel(snapshot.propertyType)}${city ? ` à ${city}` : ""}`,
        location: tribunalDisplayName({ tribunal_name: snapshot.tribunalName }) ?? "",
        headline: SALE_RESULT_HEADLINES[kind],
        detail: SALE_RESULT_DETAILS[kind].favorites,
        surenchere: surenchereWindow({
          saleDate: snapshot.saleDate,
          venueType: snapshot.venueType,
          adjudicationConfirmed: adjudicated,
          now,
        }),
        link: "favorites",
      },
      payload: { origin: "snapshot", result: snapshot.resultStatus },
    });
  }

  // 2. Statuts graves lus dans les événements du suivi des changements.
  const followed = await store.followedSales(userId);
  const visible = followed.length
    ? await store.visibleSaleIds(followed.map((sale) => sale.id))
    : new Set<string>();
  const followedVisible = followed.filter((sale) => visible.has(sale.id));
  if (followedVisible.length) {
    const events = await store.recentChangeEvents(
      userId,
      followedVisible.map((sale) => sale.id),
      new Date(now.getTime() - STATUS_LOOKBACK_HOURS * 3_600_000),
    );
    for (const event of events) {
      const classified = saleResultKindFor(event);
      if (!classified) continue;
      // Les rappels d'audience annoncent déjà adjugée, retirée et annulée : pas de second email.
      if (classified.kind !== "relisted" && (await covered(event.saleId, classified.status))) {
        continue;
      }
      const row = await store.calendarEvent(event.saleId);
      add({
        kind: classified.kind,
        saleId: event.saleId,
        item: {
          kind: classified.kind,
          saleId: event.saleId,
          title: publicTitle(row),
          location: publicLocation(row),
          headline: SALE_RESULT_HEADLINES[classified.kind],
          detail: SALE_RESULT_DETAILS[classified.kind].sale,
          surenchere: null,
          link: "sale",
        },
        payload: { origin: "status_event", status: classified.status },
      });
    }
  }

  return [...detected.values()].sort(
    (a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || a.saleId.localeCompare(b.saleId),
  );
}

export type SaleResultRunSummary = {
  mode: EmailFeatureMode;
  /** Vrai quand l'envoi d'emails est configuré (clé Resend, expéditeur, adresse du site). */
  configured: boolean;
  /** Variables d'envoi manquantes quand l'envoi n'est pas configuré. */
  missingConfig: string[];
  consentingUsers: number;
  recipients: number;
  /** Alertes détectées avant le dédoublonnage du journal. */
  candidates: number;
  /** Alertes dues mais non envoyées parce que l'envoi n'est pas configuré. */
  dueUnsent: number;
  /** Alertes réservées au journal, donc à envoyer (les autres l'avaient déjà été). */
  claimed: number;
  emailsSent: number;
  emailsFailed: number;
  /** Alertes envoyées, par type. */
  sentByKind: Record<SaleResultKind, number>;
  /** Alertes non répétées parce que les rappels d'audience ont déjà annoncé le même statut. */
  skippedCovered: number;
  /** Éléments détectés mais renvoyés au passage suivant (plus de MAX_RESULT_ITEMS_PER_EMAIL). */
  deferred: number;
  /** Vrai quand le temps imparti s'est écoulé avant la fin : le passage doit être rejoué. */
  truncated: boolean;
  skipped: "off" | null;
};

function emptySummary(mode: EmailFeatureMode): SaleResultRunSummary {
  return {
    mode,
    configured: false,
    missingConfig: [],
    consentingUsers: 0,
    recipients: 0,
    candidates: 0,
    dueUnsent: 0,
    claimed: 0,
    emailsSent: 0,
    emailsFailed: 0,
    sentByKind: { result_known: 0, result_unknown: 0, relisted: 0, withdrawn: 0 },
    skippedCovered: 0,
    deferred: 0,
    truncated: false,
    skipped: null,
  };
}

/**
 * Fait échouer le passage quand une alerte est due et ne peut pas partir : Resend non configuré
 * (comme `assertAlertNotificationDispatchComplete`), temps écoulé ou envois refusés. Les lignes `failed`
 * (moins de trois essais) sont reprises au passage suivant, tant que l'instantané ou l'événement est
 * dans sa fenêtre de relecture ; le journal empêche tout doublon.
 */
export function assertSaleResultsComplete(summary: SaleResultRunSummary): void {
  if (summary.skipped === "off") return;
  if (!summary.configured && summary.dueUnsent > 0) {
    const missing = summary.missingConfig.length
      ? ` (variable(s) manquante(s) : ${summary.missingConfig.join(", ")})`
      : "";
    throw new Error(
      `Alertes de résultat : ${summary.dueUnsent} envoi(s) dû(s) mais l'envoi d'e-mails n'est pas configuré${missing}.`,
    );
  }
  const problems = [
    summary.truncated ? "passage interrompu par le délai imparti" : null,
    summary.emailsFailed > 0 ? `${summary.emailsFailed} envoi(s) en échec` : null,
  ].filter((problem): problem is string => problem !== null);
  if (problems.length) {
    throw new Error(
      `Alertes de résultat incomplètes : ${problems.join(", ")} (${summary.emailsSent} email(s) envoyé(s)).`,
    );
  }
}

/**
 * Passage quotidien du cron `sale-results`. En mode `off` il ne lit rien et ne touche à rien. En
 * `internal` seuls les administrateurs ayant consenti reçoivent l'email (objet préfixé « [Test
 * interne] »). Un email par personne et par passage, avec au plus MAX_RESULT_ITEMS_PER_EMAIL éléments.
 */
export async function runSaleResults({
  store,
  now = new Date(),
  env = process.env,
  fetchImpl = fetch,
  mode = saleResultsMode(env),
}: {
  store: SaleResultStore;
  now?: Date;
  env?: Pick<NodeJS.ProcessEnv, string>;
  fetchImpl?: typeof fetch;
  mode?: EmailFeatureMode;
}): Promise<SaleResultRunSummary> {
  const summary = emptySummary(mode);
  if (mode === "off") return { ...summary, skipped: "off" };
  const sendMode: "internal" | "on" = mode;

  const config = resolveEmailAlertDeliveryConfig(env);
  const ready = Boolean(config.configured && config.apiKey && config.from && config.appUrl);
  summary.configured = ready;
  if (!ready) summary.missingConfig = config.missing;

  const consenting = await store.listConsentingUserIds();
  summary.consentingUsers = consenting.length;
  let recipients = consenting;
  if (mode === "internal" && consenting.length) {
    const admins = await store.filterAdminUserIds(consenting);
    recipients = consenting.filter((userId) => admins.has(userId));
  }
  summary.recipients = recipients.length;
  recipients = rotateRecipients(recipients, now);

  const deadline = Date.now() + PROCESSING_BUDGET_MS;
  async function processUser(userId: string) {
    const detected = await detectSaleResultsForUser({ store, userId, now, stats: summary });
    summary.candidates += detected.length;
    if (!detected.length) return;
    if (!ready) {
      // Détecté mais impossible à envoyer : le passage échoue (assertSaleResultsComplete).
      summary.dueUnsent += detected.length;
      return;
    }
    const { apiKey, from, appUrl } = config as { apiKey: string; from: string; appUrl: string };

    // Réserve d'abord (le journal garantit qu'une alerte ne part jamais deux fois).
    const claimed: Array<{ result: DetectedSaleResult; id: string }> = [];
    let visited = 0;
    for (const result of detected) {
      if (claimed.length >= MAX_RESULT_ITEMS_PER_EMAIL) break;
      visited += 1;
      const id = await store.claim({
        userId,
        saleId: result.saleId,
        kind: result.kind,
        mode: sendMode,
        payload: result.payload,
      });
      if (id) claimed.push({ result, id });
    }
    summary.deferred += detected.length - visited;
    summary.claimed += claimed.length;
    if (!claimed.length) return;
    const ids = claimed.map(({ id }) => id);

    // Un échec ne garde au journal qu'un code court : le détail va aux journaux d'exécution.
    const fail = async (code: SaleResultFailureCode, error?: unknown) => {
      console.error(
        JSON.stringify({
          scope: "sale-results.failure",
          code,
          ...(error === undefined ? {} : { detail: errorDetailForLog(error).slice(0, 200) }),
        }),
      );
      await store.markFailed(ids, { error: code });
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

    let stage: SaleResultFailureCode = "message_build_failed";
    try {
      const message = buildSaleResultMessage({
        userId,
        items: claimed.map(({ result }) => result.item),
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
      stage = "send_failed";
      const sent = await sendResendEmail({
        apiKey,
        message,
        idempotencyKey: `immojudis-sale-results-${userId}-${key}`,
        fetchImpl,
      });
      stage = "journal_failed";
      await store.markSent(ids, { messageId: sent.id, at: new Date() });
      summary.emailsSent += 1;
      for (const { result } of claimed) summary.sentByKind[result.kind] += 1;
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
    const settled = await Promise.allSettled(batch.map((userId) => processUser(userId)));
    const failure = settled.find((result) => result.status === "rejected");
    if (failure && failure.status === "rejected") {
      // Une erreur de lecture (base injoignable) n'est pas une absence d'alerte : le passage échoue
      // pour être vu et rejoué, le journal empêchant tout doublon.
      throw failure.reason instanceof Error
        ? failure.reason
        : new Error("Alertes de résultat : lecture impossible.");
    }
  }
  return summary;
}
