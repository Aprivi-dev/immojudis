import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), rpc: vi.fn() }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));

import { getAdminPilotage, parseAdminPilotage, unavailablePilotage } from "./admin-pilotage";

const eventCounts = (offset = 0) => ({
  unlocks: 3 + offset,
  quota_reached: {
    total: 5 + offset,
    unlocks: 1,
    favorites: 2,
    daily: 4 + offset,
    daily_account: 1,
    daily_shared: 1,
  },
  bid_ceilings: 7 + offset,
  calendar_exports: 4 + offset,
  email_clicks: { total: 9 + offset, alert: 6, reminder: 3 + offset },
});

const events = (offset = 0) => ({ ...eventCounts(offset), accounts: eventCounts(-2) });

const period = (offset = 0) => ({
  since: "2026-10-27T06:00:00Z",
  until: "2026-11-03T06:00:00Z",
  signups: 10 + offset,
  signups_confirmed: 8,
  active_accounts: 25,
  active_new: 9,
  active_returning: 16,
  alerts_created: 8,
  waitlist_requests: 4,
  dossiers: 12,
  dossier_accounts: 6,
  reminders_sent: 20,
  reminder_accounts: 7,
  events_complete: true,
  events: events(offset),
});

const summary = {
  generated_at: "2026-11-03T06:00:00Z",
  events_measured_since: "2026-10-25T08:00:00Z",
  waitlist_active: 12,
  snapshot: {
    accounts_total: 31,
    accounts_confirmed: 29,
    launch_offer_active: true,
    launch_offer_accounts: 27,
    reminder_consents_active: 14,
    dossiers_total: 40,
    dossier_accounts_total: 18,
  },
  windows: [
    { ...period(), days: 7, since: "2026-10-27T06:00:00Z", previous: period(-3) },
    {
      ...period(30),
      days: 30,
      since: "2026-10-04T06:00:00Z",
      events_complete: false,
      previous: null,
    },
  ],
};

describe("parseAdminPilotage", () => {
  it("reads the exact figures of both windows, the previous week and the snapshot", () => {
    const pilotage = parseAdminPilotage(summary);

    expect(pilotage.generatedAt).toBe("2026-11-03T06:00:00Z");
    expect(pilotage.eventsMeasuredSince).toBe("2026-10-25T08:00:00Z");
    expect(pilotage.waitlistActive).toBe(12);
    expect(pilotage.windows.map((window) => window.days)).toEqual([7, 30]);
    const week = pilotage.windows[0];
    expect(week).toMatchObject({
      days: 7,
      since: "2026-10-27T06:00:00Z",
      signups: 10,
      signupsConfirmed: 8,
      activeAccounts: 25,
      activeNew: 9,
      activeReturning: 16,
      alertsCreated: 8,
      waitlistRequests: 4,
      dossiers: 12,
      dossierAccounts: 6,
      remindersSent: 20,
      reminderAccounts: 7,
      eventsComplete: true,
    });
    expect(week.events.unlocks).toBe(3);
    expect(week.events.quotaReached).toEqual({
      total: 5,
      unlocks: 1,
      favorites: 2,
      daily: 4,
      dailyAccount: 1,
      dailyShared: 1,
    });
    expect(week.events.emailClicks).toEqual({ total: 9, alert: 6, reminder: 3 });
    // Les comptes distincts ont la même forme que les occurrences.
    expect(week.events.accounts.unlocks).toBe(1);
    expect(week.events.accounts.quotaReached.dailyAccount).toBe(1);
    expect(week.previous?.signups).toBe(7);
    expect(week.previous?.events.unlocks).toBe(0);
    expect(pilotage.windows[1].previous).toBeNull();
    expect(pilotage.windows[1].eventsComplete).toBe(false);
    expect(pilotage.windows[1].events.emailClicks.total).toBe(39);
    expect(pilotage.snapshot).toEqual({
      accountsTotal: 31,
      accountsConfirmed: 29,
      launchOfferActive: true,
      launchOfferAccounts: 27,
      reminderConsentsActive: 14,
      dossiersTotal: 40,
      dossierAccountsTotal: 18,
    });
  });

  it("keeps a real zero as zero and an absent figure as null (never extrapolated)", () => {
    const pilotage = parseAdminPilotage({
      ...summary,
      waitlist_active: 0,
      windows: [
        { ...summary.windows[0], signups: 0, events: null, previous: null },
        { days: 30, since: null },
      ],
    });

    expect(pilotage.waitlistActive).toBe(0);
    expect(pilotage.windows[0].signups).toBe(0);
    expect(pilotage.windows[0].events).toEqual(unavailablePilotage().windows[0].events);
    expect(pilotage.windows[0].events.unlocks).toBeNull();
    expect(pilotage.windows[0].events.accounts.unlocks).toBeNull();
    // Une semaine précédente absente vaut « non mesuré », pas zéro.
    expect(pilotage.windows[0].previous?.signups).toBeNull();
    expect(pilotage.windows[1].signups).toBeNull();
    expect(pilotage.windows[1].alertsCreated).toBeNull();
    expect(pilotage.windows[1].eventsComplete).toBe(false);
  });

  it("reads an answer of the former function without inventing the new figures", () => {
    const pilotage = parseAdminPilotage({
      generated_at: "2026-11-03T06:00:00Z",
      events_measured_since: null,
      waitlist_active: 1,
      windows: [
        {
          days: 7,
          since: "2026-10-27T06:00:00Z",
          signups: 3,
          active_accounts: 2,
          alerts_created: 0,
          waitlist_requests: 0,
          events_complete: false,
          events: {
            unlocks: 1,
            quota_reached: { total: 1, unlocks: 0, favorites: 0, daily: 1 },
            bid_ceilings: 0,
            calendar_exports: 0,
            email_clicks: { total: 0, alert: 0, reminder: 0 },
          },
        },
      ],
    });

    expect(pilotage.windows[0].signups).toBe(3);
    expect(pilotage.windows[0].signupsConfirmed).toBeNull();
    expect(pilotage.windows[0].events.quotaReached.daily).toBe(1);
    expect(pilotage.windows[0].events.quotaReached.dailyAccount).toBeNull();
    expect(pilotage.windows[0].events.accounts.unlocks).toBeNull();
    expect(pilotage.snapshot).toEqual(unavailablePilotage().snapshot);
  });

  it("fills a missing window with « non mesuré » figures", () => {
    const pilotage = parseAdminPilotage({ ...summary, windows: [summary.windows[0]] });

    expect(pilotage.windows).toHaveLength(2);
    expect(pilotage.windows[1]).toEqual(unavailablePilotage().windows[1]);
  });

  it("rejects an invalid figure instead of showing it", () => {
    expect(() =>
      parseAdminPilotage({ ...summary, windows: [{ ...summary.windows[0], signups: -1 }] }),
    ).toThrow();
    expect(() => parseAdminPilotage({ ...summary, windows: "none" })).toThrow();
    expect(() =>
      parseAdminPilotage({ ...summary, snapshot: { ...summary.snapshot, accounts_total: 1.5 } }),
    ).toThrow();
  });

  it("carries only numbers and dates: no person, no list", () => {
    const text = JSON.stringify(parseAdminPilotage(summary));
    expect(text).not.toMatch(/user|account_id|@/i);
  });
});

describe("getAdminPilotage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireAuth.mockResolvedValue({ userId: "admin-1", isAdmin: true });
    mocks.rpc.mockResolvedValue({ data: summary, error: null });
  });

  it("reads the summary at the given instant for an administrator", async () => {
    const now = new Date("2026-11-03T06:00:00Z");

    const pilotage = await getAdminPilotage("token", now);

    expect(mocks.requireAuth).toHaveBeenCalledWith("token");
    expect(mocks.rpc).toHaveBeenCalledWith("admin_pilotage_summary", {
      p_now: "2026-11-03T06:00:00.000Z",
    });
    expect(pilotage.windows[0].signups).toBe(10);
  });

  it("refuses an account without the administrator role, before reading anything", async () => {
    mocks.requireAuth.mockResolvedValue({ userId: "user-1", isAdmin: false });

    await expect(getAdminPilotage("token")).rejects.toThrow("Forbidden");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuses a request without a valid session", async () => {
    mocks.requireAuth.mockRejectedValue(new Error("Unauthorized: missing bearer token"));

    await expect(getAdminPilotage("")).rejects.toThrow("Unauthorized");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("answers « non mesuré » everywhere when the database function is not deployed yet", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "not found" } });

    await expect(getAdminPilotage("token")).resolves.toEqual(unavailablePilotage());
  });

  it("raises any other database error", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });

    await expect(getAdminPilotage("token")).rejects.toMatchObject({ code: "XX000" });
  });
});
