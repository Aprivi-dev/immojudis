import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), rpc: vi.fn() }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));

import { getAdminPilotage, parseAdminPilotage, unavailablePilotage } from "./admin-pilotage";

const events = (offset = 0) => ({
  unlocks: 3 + offset,
  quota_reached: { total: 5 + offset, unlocks: 1, favorites: 2, daily: 2 + offset },
  bid_ceilings: 7 + offset,
  calendar_exports: 4 + offset,
  email_clicks: { total: 9 + offset, alert: 6, reminder: 3 + offset },
});

const summary = {
  generated_at: "2026-11-03T06:00:00Z",
  events_measured_since: "2026-10-25T08:00:00Z",
  waitlist_active: 12,
  windows: [
    {
      days: 7,
      since: "2026-10-27T06:00:00Z",
      signups: 10,
      active_accounts: 25,
      alerts_created: 8,
      waitlist_requests: 4,
      events_complete: true,
      events: events(),
    },
    {
      days: 30,
      since: "2026-10-04T06:00:00Z",
      signups: 40,
      active_accounts: 60,
      alerts_created: 31,
      waitlist_requests: 15,
      events_complete: false,
      events: events(10),
    },
  ],
};

describe("parseAdminPilotage", () => {
  it("reads the exact figures of both windows without changing them", () => {
    const pilotage = parseAdminPilotage(summary);

    expect(pilotage.generatedAt).toBe("2026-11-03T06:00:00Z");
    expect(pilotage.eventsMeasuredSince).toBe("2026-10-25T08:00:00Z");
    expect(pilotage.waitlistActive).toBe(12);
    expect(pilotage.windows.map((window) => window.days)).toEqual([7, 30]);
    expect(pilotage.windows[0]).toEqual({
      days: 7,
      since: "2026-10-27T06:00:00Z",
      signups: 10,
      activeAccounts: 25,
      alertsCreated: 8,
      waitlistRequests: 4,
      eventsComplete: true,
      events: {
        unlocks: 3,
        quotaReached: { total: 5, unlocks: 1, favorites: 2, daily: 2 },
        bidCeilings: 7,
        calendarExports: 4,
        emailClicks: { total: 9, alert: 6, reminder: 3 },
      },
    });
    expect(pilotage.windows[1].eventsComplete).toBe(false);
    expect(pilotage.windows[1].events.emailClicks.total).toBe(19);
  });

  it("keeps a real zero as zero and an absent figure as null (never extrapolated)", () => {
    const pilotage = parseAdminPilotage({
      ...summary,
      waitlist_active: 0,
      windows: [
        {
          ...summary.windows[0],
          signups: 0,
          events: null,
        },
        { days: 30, since: null },
      ],
    });

    expect(pilotage.waitlistActive).toBe(0);
    expect(pilotage.windows[0].signups).toBe(0);
    expect(pilotage.windows[0].events).toEqual(unavailablePilotage().windows[0].events);
    expect(pilotage.windows[0].events.unlocks).toBeNull();
    expect(pilotage.windows[1].signups).toBeNull();
    expect(pilotage.windows[1].alertsCreated).toBeNull();
    expect(pilotage.windows[1].eventsComplete).toBe(false);
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
