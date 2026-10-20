import "server-only";
import { z } from "zod";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

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
