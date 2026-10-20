import "server-only";
import { z } from "zod";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asRecord, stringValue } from "@/lib/guards";
import { parisDateKey } from "@/lib/sale-countdown";

/**
 * Page admin « Pilotage » (point 65) : agrégats sur 7 et 30 jours glissants, lus dans la base par
 * `admin_pilotage_summary`. Nombres exacts, sans extrapolation, jamais de liste de personnes.
 *
 * Même protection que les autres routes admin : jeton de session vérifié, rôle administrateur et
 * double authentification (`auth.isAdmin`), puis lecture avec le client de service. Un compte sans
 * le rôle n'obtient rien.
 *
 * Un nombre absent vaut `null` et s'affiche « non mesuré » : migration pas encore appliquée, début de
 * la mesure inconnu. Il n'est jamais remplacé par zéro.
 */

export type PilotageCount = number | null;

export type PilotageEvents = {
  unlocks: PilotageCount;
  quotaReached: {
    total: PilotageCount;
    unlocks: PilotageCount;
    favorites: PilotageCount;
    daily: PilotageCount;
  };
  bidCeilings: PilotageCount;
  calendarExports: PilotageCount;
  emailClicks: { total: PilotageCount; alert: PilotageCount; reminder: PilotageCount };
};

export type PilotageWindow = {
  days: 7 | 30;
  /** Début de la fenêtre glissante (ISO). */
  since: string | null;
  signups: PilotageCount;
  activeAccounts: PilotageCount;
  alertsCreated: PilotageCount;
  waitlistRequests: PilotageCount;
  /** Faux quand la mesure des événements a commencé après le début de la fenêtre. */
  eventsComplete: boolean;
  events: PilotageEvents;
};

export type AdminPilotage = {
  generatedAt: string | null;
  /** Début de la mesure des événements ; `null` : inconnu. */
  eventsMeasuredSince: string | null;
  /** Demandes de liste d'attente actives à cet instant. */
  waitlistActive: PilotageCount;
  windows: PilotageWindow[];
};

const count = z.number().int().nonnegative().nullish();
const quotaSchema = z.object({
  total: count,
  unlocks: count,
  favorites: count,
  daily: count,
});
const clicksSchema = z.object({ total: count, alert: count, reminder: count });
const eventsSchema = z.object({
  unlocks: count,
  quota_reached: quotaSchema.nullish(),
  bid_ceilings: count,
  calendar_exports: count,
  email_clicks: clicksSchema.nullish(),
});
const windowSchema = z.object({
  days: z.union([z.literal(7), z.literal(30)]),
  since: z.string().nullish(),
  signups: count,
  active_accounts: count,
  alerts_created: count,
  waitlist_requests: count,
  events_complete: z.boolean().nullish(),
  events: eventsSchema.nullish(),
});
const summarySchema = z.object({
  generated_at: z.string().nullish(),
  events_measured_since: z.string().nullish(),
  waitlist_active: count,
  windows: z.array(windowSchema),
});

const orNull = (value: number | null | undefined): PilotageCount => value ?? null;

function unmeasuredEvents(): PilotageEvents {
  return {
    unlocks: null,
    quotaReached: { total: null, unlocks: null, favorites: null, daily: null },
    bidCeilings: null,
    calendarExports: null,
    emailClicks: { total: null, alert: null, reminder: null },
  };
}

/** Réponse quand rien n'a pu être mesuré : tout vaut « non mesuré », jamais zéro. */
export function unavailablePilotage(): AdminPilotage {
  return {
    generatedAt: null,
    eventsMeasuredSince: null,
    waitlistActive: null,
    windows: ([7, 30] as const).map((days) => ({
      days,
      since: null,
      signups: null,
      activeAccounts: null,
      alertsCreated: null,
      waitlistRequests: null,
      eventsComplete: false,
      events: unmeasuredEvents(),
    })),
  };
}

/** Lit la réponse JSON de `admin_pilotage_summary`. Les fenêtres absentes valent « non mesuré ». */
export function parseAdminPilotage(raw: unknown): AdminPilotage {
  const summary = summarySchema.parse(raw);
  const byDays = new Map(summary.windows.map((window) => [window.days, window]));
  return {
    generatedAt: summary.generated_at ?? null,
    eventsMeasuredSince: summary.events_measured_since ?? null,
    waitlistActive: orNull(summary.waitlist_active),
    windows: ([7, 30] as const).map((days): PilotageWindow => {
      const window = byDays.get(days);
      if (!window) return unavailablePilotage().windows[days === 7 ? 0 : 1];
      const events = window.events;
      return {
        days,
        since: window.since ?? null,
        signups: orNull(window.signups),
        activeAccounts: orNull(window.active_accounts),
        alertsCreated: orNull(window.alerts_created),
        waitlistRequests: orNull(window.waitlist_requests),
        eventsComplete: window.events_complete === true,
        events: events
          ? {
              unlocks: orNull(events.unlocks),
              quotaReached: {
                total: orNull(events.quota_reached?.total),
                unlocks: orNull(events.quota_reached?.unlocks),
                favorites: orNull(events.quota_reached?.favorites),
                daily: orNull(events.quota_reached?.daily),
              },
              bidCeilings: orNull(events.bid_ceilings),
              calendarExports: orNull(events.calendar_exports),
              emailClicks: {
                total: orNull(events.email_clicks?.total),
                alert: orNull(events.email_clicks?.alert),
                reminder: orNull(events.email_clicks?.reminder),
              },
            }
          : unmeasuredEvents(),
      };
    }),
  };
}

/** Fonction de base absente (migration pas encore appliquée) : rien n'est mesuré. */
function isMissingFunction(error: { code?: string } | null): boolean {
  return error?.code === "PGRST202" || error?.code === "42883";
}

export async function getAdminPilotage(
  authToken: string,
  now = new Date(),
): Promise<AdminPilotage> {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");

  const { data, error } = await supabaseAdmin.rpc("admin_pilotage_summary", {
    p_now: now.toISOString(),
  });
  if (error) {
    if (isMissingFunction(error)) return unavailablePilotage();
    throw error;
  }
  return parseAdminPilotage(data);
}

/**
 * Fausses alertes des rappels d'audience (activation mesurée, voir
 * `docs/runbooks/activation-rappels-audience.md`).
 *
 * Un rappel J-7 ou J-1 est « contredit » quand la date d'audience de la vente change vers un autre
 * jour (événement `audience_changed` du suivi des changements, jour civil de Paris) dans les 72 h qui
 * suivent son envoi. Le taux se mesure sur les rappels envoyés (modes `internal` et `on`) dont ces
 * 72 h sont écoulées, et le critère de passage à `on` est : moins de 2 % de rappels contredits sur
 * au moins 100 rappels.
 *
 * Le calcul est pur (`computeSaleReminderAccuracy`) ; `loadSaleReminderAccuracy` lit les deux tables
 * avec le client de service et `getAdminSaleReminderAccuracy` y ajoute le contrôle du rôle
 * administrateur. Comme le reste du pilotage : des nombres, jamais de liste de personnes, et une mesure
 * impossible vaut « non mesuré » (`null`), jamais zéro.
 */
export const REMINDER_ACCURACY_WINDOW_DAYS = 30;
/** Délai pendant lequel un changement de date contredit un rappel déjà envoyé. */
export const REMINDER_CONTRADICTION_HOURS = 72;
/** Nombre minimal de rappels mesurés pour conclure. */
export const REMINDER_ACCURACY_MIN_SAMPLE = 100;
/** Part maximale (exclue) de rappels contredits pour passer à `on` : moins de 2 %. */
export const REMINDER_ACCURACY_MAX_RATE = 0.02;

const REMINDER_ACCURACY_PAGE_SIZE = 1_000;
/** Pages lues au plus par table : au-delà, la mesure est dite non mesurée plutôt que partielle. */
const REMINDER_ACCURACY_MAX_PAGES = 20;
const HOUR_MS = 3_600_000;

export type SaleReminderDispatchSample = {
  userId: string;
  saleId: string;
  /** Instant d'envoi (ISO). */
  sentAt: string;
};

export type AudienceChangeSample = {
  userId: string;
  saleId: string;
  /** Instant de détection du changement (ISO). */
  detectedAt: string;
  previousDate: string | null;
  currentDate: string | null;
};

export type SaleReminderAccuracyVerdict =
  /** Moins de 2 % de rappels contredits sur au moins 100 rappels : le passage à `on` est justifié. */
  | "met"
  /** Au moins 2 % de rappels contredits sur au moins 100 rappels. */
  | "not_met"
  /** Moins de 100 rappels mesurés : on ne conclut pas. */
  | "insufficient_sample"
  /** Mesure impossible (lecture tronquée). */
  | "unavailable";

export type SaleReminderAccuracy = {
  windowDays: number;
  /** Début de la fenêtre glissante (ISO). */
  since: string;
  generatedAt: string;
  /** Rappels J-7 et J-1 envoyés dans la fenêtre dont les 72 h de suivi sont écoulées. */
  measuredReminders: PilotageCount;
  /** Parmi eux, ceux qu'un changement de date d'audience a contredits dans les 72 h. */
  contradictedReminders: PilotageCount;
  /** Part contredite entre 0 et 1 ; `null` sans rappel mesuré ou mesure impossible. */
  contradictionRate: number | null;
  /** Critère écrit : taux strictement inférieur à `maxRate` sur au moins `minimumSample` rappels. */
  minimumSample: number;
  maxRate: number;
  verdict: SaleReminderAccuracyVerdict;
};

/** Mesure impossible : tout vaut « non mesuré ». */
export function unavailableSaleReminderAccuracy(
  now: Date,
  windowDays = REMINDER_ACCURACY_WINDOW_DAYS,
): SaleReminderAccuracy {
  return {
    windowDays,
    since: new Date(now.getTime() - windowDays * 24 * HOUR_MS).toISOString(),
    generatedAt: now.toISOString(),
    measuredReminders: null,
    contradictedReminders: null,
    contradictionRate: null,
    minimumSample: REMINDER_ACCURACY_MIN_SAMPLE,
    maxRate: REMINDER_ACCURACY_MAX_RATE,
    verdict: "unavailable",
  };
}

function parisDayOrNull(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? parisDateKey(date) : null;
}

/**
 * Calcule le taux de rappels contredits. Un rappel compte s'il a été envoyé dans la fenêtre et depuis
 * plus de 72 h (on ne juge pas un rappel dont le délai de contradiction court encore). Il est contredit
 * par un changement de la même personne sur la même vente, détecté après l'envoi et au plus 72 h
 * après, qui déplace l'audience vers un autre jour de Paris (un simple changement d'heure le même jour
 * ne contredit pas le jour annoncé).
 */
export function computeSaleReminderAccuracy({
  dispatches,
  changes,
  now,
  windowDays = REMINDER_ACCURACY_WINDOW_DAYS,
}: {
  dispatches: readonly SaleReminderDispatchSample[];
  changes: readonly AudienceChangeSample[];
  now: Date;
  windowDays?: number;
}): SaleReminderAccuracy {
  const since = now.getTime() - windowDays * 24 * HOUR_MS;
  const delay = REMINDER_CONTRADICTION_HOURS * HOUR_MS;

  const movedByKey = new Map<string, number[]>();
  for (const change of changes) {
    const previousDay = parisDayOrNull(change.previousDate);
    const currentDay = parisDayOrNull(change.currentDate);
    if (!previousDay || !currentDay || previousDay === currentDay) continue;
    const detected = Date.parse(change.detectedAt);
    if (!Number.isFinite(detected)) continue;
    const key = `${change.userId}|${change.saleId}`;
    const times = movedByKey.get(key);
    if (times) times.push(detected);
    else movedByKey.set(key, [detected]);
  }

  let measured = 0;
  let contradicted = 0;
  for (const dispatch of dispatches) {
    const sent = Date.parse(dispatch.sentAt);
    if (!Number.isFinite(sent) || sent < since || sent + delay > now.getTime()) continue;
    measured += 1;
    const moves = movedByKey.get(`${dispatch.userId}|${dispatch.saleId}`) ?? [];
    if (moves.some((detected) => detected > sent && detected <= sent + delay)) contradicted += 1;
  }

  const rate = measured > 0 ? contradicted / measured : null;
  const verdict: SaleReminderAccuracyVerdict =
    measured < REMINDER_ACCURACY_MIN_SAMPLE
      ? "insufficient_sample"
      : rate !== null && rate < REMINDER_ACCURACY_MAX_RATE
        ? "met"
        : "not_met";
  return {
    windowDays,
    since: new Date(since).toISOString(),
    generatedAt: now.toISOString(),
    measuredReminders: measured,
    contradictedReminders: contradicted,
    contradictionRate: rate,
    minimumSample: REMINDER_ACCURACY_MIN_SAMPLE,
    maxRate: REMINDER_ACCURACY_MAX_RATE,
    verdict,
  };
}

/** Lit toutes les pages d'une requête ; `null` quand la limite de pages est atteinte (lecture tronquée). */
async function readAccuracyPages<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[] | null> {
  const rows: T[] = [];
  for (let index = 0; index < REMINDER_ACCURACY_MAX_PAGES; index += 1) {
    const from = index * REMINDER_ACCURACY_PAGE_SIZE;
    const { data, error } = await page(from, from + REMINDER_ACCURACY_PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < REMINDER_ACCURACY_PAGE_SIZE) return rows;
  }
  return null;
}

/**
 * Taux de rappels contredits sur la fenêtre, lu dans `sale_reminder_dispatches` (rappels envoyés) et
 * `user_sale_change_events` (changements de date). À n'appeler qu'après le contrôle du rôle
 * administrateur : `getAdminSaleReminderAccuracy` le fait. Lecture tronquée : « non mesuré ».
 */
export async function loadSaleReminderAccuracy(
  now = new Date(),
  windowDays = REMINDER_ACCURACY_WINDOW_DAYS,
): Promise<SaleReminderAccuracy> {
  const since = new Date(now.getTime() - windowDays * 24 * HOUR_MS).toISOString();
  const matureBefore = new Date(
    now.getTime() - REMINDER_CONTRADICTION_HOURS * HOUR_MS,
  ).toISOString();

  const [dispatchRows, changeRows] = await Promise.all([
    readAccuracyPages((from, to) =>
      supabaseAdmin
        .from("sale_reminder_dispatches")
        .select("user_id,sale_id,sent_at")
        .eq("status", "sent")
        .in("reminder_kind", ["audience_j7", "audience_j1"])
        .gte("sent_at", since)
        .lte("sent_at", matureBefore)
        .order("sent_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    readAccuracyPages((from, to) =>
      supabaseAdmin
        .from("user_sale_change_events")
        .select("user_id,sale_id,detected_at,change_summary")
        .eq("event_kind", "audience_changed")
        .gte("detected_at", since)
        .lte("detected_at", now.toISOString())
        .order("detected_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);
  if (!dispatchRows || !changeRows) return unavailableSaleReminderAccuracy(now, windowDays);

  return computeSaleReminderAccuracy({
    dispatches: dispatchRows.flatMap((row) =>
      row.sent_at ? [{ userId: row.user_id, saleId: row.sale_id, sentAt: row.sent_at }] : [],
    ),
    changes: changeRows.map((row) => {
      const summary = asRecord(row.change_summary);
      return {
        userId: row.user_id,
        saleId: row.sale_id,
        detectedAt: row.detected_at,
        previousDate: stringValue(summary.previousValue),
        currentDate: stringValue(summary.currentValue),
      };
    }),
    now,
    windowDays,
  });
}

/** Comme `loadSaleReminderAccuracy`, après vérification du jeton et du rôle administrateur. */
export async function getAdminSaleReminderAccuracy(
  authToken: string,
  now = new Date(),
): Promise<SaleReminderAccuracy> {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");
  return loadSaleReminderAccuracy(now);
}
