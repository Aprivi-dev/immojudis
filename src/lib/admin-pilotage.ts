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
 * la mesure inconnu. Il n'est jamais remplacé par zéro. La règle « moins de 5 » est une règle
 * d'affichage : la page masque les petits nombres (voir `admin-pilotage-page.tsx`).
 *
 * Depuis la migration 20261029120200 : administrateurs exclus, semaine précédente (fenêtre
 * disjointe), comptes distincts à côté des occurrences, état à cet instant (`snapshot`).
 */

export type PilotageCount = number | null;

/** Les compteurs d'événements : des occurrences, ou des comptes distincts (même forme). */
export type PilotageEventCounts = {
  unlocks: PilotageCount;
  quotaReached: {
    total: PilotageCount;
    unlocks: PilotageCount;
    favorites: PilotageCount;
    /** Les trois détails du plafond quotidien : par compte, par adresse ou global, et l'ancien. */
    daily: PilotageCount;
    /** Plafond journalier du compte. */
    dailyAccount: PilotageCount;
    /** Plafond journalier de l'adresse ou du site entier. */
    dailyShared: PilotageCount;
  };
  bidCeilings: PilotageCount;
  calendarExports: PilotageCount;
  emailClicks: { total: PilotageCount; alert: PilotageCount; reminder: PilotageCount };
};

/** Occurrences, et à côté les comptes distincts (`count(distinct user_id)`). */
export type PilotageEvents = PilotageEventCounts & { accounts: PilotageEventCounts };

/** Les chiffres d'une période (hors administrateurs). */
export type PilotagePeriod = {
  /** Début (exclu) et fin (incluse) de la période (ISO). */
  since: string | null;
  until: string | null;
  /** Comptes créés, et parmi eux ceux dont l'adresse email est confirmée. */
  signups: PilotageCount;
  signupsConfirmed: PilotageCount;
  /** Comptes dont la dernière connexion tombe dans la période : nouveaux (créés dans la période) ou revenus. */
  activeAccounts: PilotageCount;
  activeNew: PilotageCount;
  activeReturning: PilotageCount;
  alertsCreated: PilotageCount;
  waitlistRequests: PilotageCount;
  /** Dossiers enregistrés (statut personnel ou enchère plafond sur un favori), et comptes distincts. */
  dossiers: PilotageCount;
  dossierAccounts: PilotageCount;
  /** Rappels d'audience envoyés, et comptes distincts atteints. */
  remindersSent: PilotageCount;
  reminderAccounts: PilotageCount;
  /** Faux quand la mesure des événements a commencé après le début de la période. */
  eventsComplete: boolean;
  events: PilotageEvents;
};

export type PilotageWindow = PilotagePeriod & {
  days: 7 | 30;
  /** La période disjointe qui précède (les 7 jours d'avant la semaine) ; `null` pour les 30 jours. */
  previous: PilotagePeriod | null;
};

/** État à cet instant, sans fenêtre. */
export type PilotageSnapshot = {
  /** Comptes hors administrateurs, et parmi eux les confirmés. */
  accountsTotal: PilotageCount;
  accountsConfirmed: PilotageCount;
  launchOfferActive: boolean | null;
  /** Comptes qui n'ont l'accès Analyse que grâce à l'offre de lancement. */
  launchOfferAccounts: PilotageCount;
  reminderConsentsActive: PilotageCount;
  dossiersTotal: PilotageCount;
  dossierAccountsTotal: PilotageCount;
};

export type AdminPilotage = {
  generatedAt: string | null;
  /** Début de la mesure des événements ; `null` : inconnu. */
  eventsMeasuredSince: string | null;
  /** Demandes de liste d'attente actives à cet instant. */
  waitlistActive: PilotageCount;
  snapshot: PilotageSnapshot;
  windows: PilotageWindow[];
};

/** Réponse de la route : le pilotage et, sous `saleReminders`, le taux de fausses alertes des rappels. */
export type AdminPilotageResponse = AdminPilotage & { saleReminders?: SaleReminderAccuracy };

const count = z.number().int().nonnegative().nullish();
const quotaSchema = z.object({
  total: count,
  unlocks: count,
  favorites: count,
  daily: count,
  daily_account: count,
  daily_shared: count,
});
const clicksSchema = z.object({ total: count, alert: count, reminder: count });
const eventCountsShape = {
  unlocks: count,
  quota_reached: quotaSchema.nullish(),
  bid_ceilings: count,
  calendar_exports: count,
  email_clicks: clicksSchema.nullish(),
};
const eventCountsSchema = z.object(eventCountsShape);
const eventsSchema = z.object({ ...eventCountsShape, accounts: eventCountsSchema.nullish() });
const periodShape = {
  since: z.string().nullish(),
  until: z.string().nullish(),
  signups: count,
  signups_confirmed: count,
  active_accounts: count,
  active_new: count,
  active_returning: count,
  alerts_created: count,
  waitlist_requests: count,
  dossiers: count,
  dossier_accounts: count,
  reminders_sent: count,
  reminder_accounts: count,
  events_complete: z.boolean().nullish(),
  events: eventsSchema.nullish(),
};
const periodSchema = z.object(periodShape);
const windowSchema = z.object({
  ...periodShape,
  days: z.union([z.literal(7), z.literal(30)]),
  previous: periodSchema.nullish(),
});
const snapshotSchema = z.object({
  accounts_total: count,
  accounts_confirmed: count,
  launch_offer_active: z.boolean().nullish(),
  launch_offer_accounts: count,
  reminder_consents_active: count,
  dossiers_total: count,
  dossier_accounts_total: count,
});
const summarySchema = z.object({
  generated_at: z.string().nullish(),
  events_measured_since: z.string().nullish(),
  waitlist_active: count,
  snapshot: snapshotSchema.nullish(),
  windows: z.array(windowSchema),
});

const orNull = (value: number | null | undefined): PilotageCount => value ?? null;

function unmeasuredEventCounts(): PilotageEventCounts {
  return {
    unlocks: null,
    quotaReached: {
      total: null,
      unlocks: null,
      favorites: null,
      daily: null,
      dailyAccount: null,
      dailyShared: null,
    },
    bidCeilings: null,
    calendarExports: null,
    emailClicks: { total: null, alert: null, reminder: null },
  };
}

function unmeasuredPeriod(): PilotagePeriod {
  return {
    since: null,
    until: null,
    signups: null,
    signupsConfirmed: null,
    activeAccounts: null,
    activeNew: null,
    activeReturning: null,
    alertsCreated: null,
    waitlistRequests: null,
    dossiers: null,
    dossierAccounts: null,
    remindersSent: null,
    reminderAccounts: null,
    eventsComplete: false,
    events: { ...unmeasuredEventCounts(), accounts: unmeasuredEventCounts() },
  };
}

function unmeasuredSnapshot(): PilotageSnapshot {
  return {
    accountsTotal: null,
    accountsConfirmed: null,
    launchOfferActive: null,
    launchOfferAccounts: null,
    reminderConsentsActive: null,
    dossiersTotal: null,
    dossierAccountsTotal: null,
  };
}

/** Réponse quand rien n'a pu être mesuré : tout vaut « non mesuré », jamais zéro. */
export function unavailablePilotage(): AdminPilotage {
  return {
    generatedAt: null,
    eventsMeasuredSince: null,
    waitlistActive: null,
    snapshot: unmeasuredSnapshot(),
    windows: ([7, 30] as const).map((days) => ({
      ...unmeasuredPeriod(),
      days,
      previous: days === 7 ? unmeasuredPeriod() : null,
    })),
  };
}

function parseEventCounts(
  events: z.infer<typeof eventCountsSchema> | null | undefined,
): PilotageEventCounts {
  if (!events) return unmeasuredEventCounts();
  return {
    unlocks: orNull(events.unlocks),
    quotaReached: {
      total: orNull(events.quota_reached?.total),
      unlocks: orNull(events.quota_reached?.unlocks),
      favorites: orNull(events.quota_reached?.favorites),
      daily: orNull(events.quota_reached?.daily),
      dailyAccount: orNull(events.quota_reached?.daily_account),
      dailyShared: orNull(events.quota_reached?.daily_shared),
    },
    bidCeilings: orNull(events.bid_ceilings),
    calendarExports: orNull(events.calendar_exports),
    emailClicks: {
      total: orNull(events.email_clicks?.total),
      alert: orNull(events.email_clicks?.alert),
      reminder: orNull(events.email_clicks?.reminder),
    },
  };
}

function parsePeriod(period: z.infer<typeof periodSchema>): PilotagePeriod {
  const events = period.events;
  return {
    since: period.since ?? null,
    until: period.until ?? null,
    signups: orNull(period.signups),
    signupsConfirmed: orNull(period.signups_confirmed),
    activeAccounts: orNull(period.active_accounts),
    activeNew: orNull(period.active_new),
    activeReturning: orNull(period.active_returning),
    alertsCreated: orNull(period.alerts_created),
    waitlistRequests: orNull(period.waitlist_requests),
    dossiers: orNull(period.dossiers),
    dossierAccounts: orNull(period.dossier_accounts),
    remindersSent: orNull(period.reminders_sent),
    reminderAccounts: orNull(period.reminder_accounts),
    eventsComplete: period.events_complete === true,
    events: {
      ...parseEventCounts(events),
      accounts: parseEventCounts(events?.accounts),
    },
  };
}

/** Lit la réponse JSON de `admin_pilotage_summary`. Les fenêtres absentes valent « non mesuré ». */
export function parseAdminPilotage(raw: unknown): AdminPilotage {
  const summary = summarySchema.parse(raw);
  const byDays = new Map(summary.windows.map((window) => [window.days, window]));
  const snapshot = summary.snapshot;
  return {
    generatedAt: summary.generated_at ?? null,
    eventsMeasuredSince: summary.events_measured_since ?? null,
    waitlistActive: orNull(summary.waitlist_active),
    snapshot: snapshot
      ? {
          accountsTotal: orNull(snapshot.accounts_total),
          accountsConfirmed: orNull(snapshot.accounts_confirmed),
          launchOfferActive: snapshot.launch_offer_active ?? null,
          launchOfferAccounts: orNull(snapshot.launch_offer_accounts),
          reminderConsentsActive: orNull(snapshot.reminder_consents_active),
          dossiersTotal: orNull(snapshot.dossiers_total),
          dossierAccountsTotal: orNull(snapshot.dossier_accounts_total),
        }
      : unmeasuredSnapshot(),
    windows: ([7, 30] as const).map((days): PilotageWindow => {
      const window = byDays.get(days);
      if (!window) return unavailablePilotage().windows[days === 7 ? 0 : 1];
      return {
        ...parsePeriod(window),
        days,
        previous: window.previous
          ? parsePeriod(window.previous)
          : days === 7
            ? unmeasuredPeriod()
            : null,
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
