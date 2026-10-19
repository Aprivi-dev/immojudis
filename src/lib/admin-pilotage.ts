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
