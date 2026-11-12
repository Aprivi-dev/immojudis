import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";

const mocks = vi.hoisted(() => ({ after: vi.fn(), insert: vi.fn() }));

// `after()` only exists inside a request: the test keeps the callbacks and runs them by hand.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: mocks.after,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: () => ({ insert: mocks.insert }) },
}));

import { buildUsageLimitState, getPlanUsageSummary, recordFeatureUsageEvent } from "@/lib/usage";

/** An account whose usage reads record the window they were asked for. */
function accountReadingUsage() {
  const windows: Array<{ gte?: string; lt?: string }> = [];
  const from = () => {
    const window: { gte?: string; lt?: string } = {};
    windows.push(window);
    const query = {
      select: () => query,
      eq: () => query,
      gte: (_column: string, value: string) => {
        window.gte = value;
        return query;
      },
      lt: (_column: string, value: string) => {
        window.lt = value;
        return Promise.resolve({ data: [{ quantity: 2 }], error: null });
      },
    };
    return query;
  };
  const auth = { userId: "user-1", supabase: { from } } as unknown as SupabaseAuthContext;
  return { auth, windows };
}

const plan = { label: "Analyse", limits: { propertyReportsPerMonth: null, pdfExportsPerMonth: 5 } };

describe("feature usage limits", () => {
  it("builds monthly usage windows on the Paris calendar month", async () => {
    const { auth, windows } = accountReadingUsage();

    const summary = await getPlanUsageSummary({
      auth,
      plan,
      now: new Date("2026-07-06T08:30:00.000Z"),
    });

    // 1er juillet 00 h 00 à Paris (UTC+2) = 30 juin 22 h 00 UTC.
    expect(summary).toMatchObject({
      periodStart: "2026-06-30T22:00:00.000Z",
      periodEnd: "2026-07-31T22:00:00.000Z",
    });
    expect(windows).toEqual([
      { gte: "2026-06-30T22:00:00.000Z", lt: "2026-07-31T22:00:00.000Z" },
      { gte: "2026-06-30T22:00:00.000Z", lt: "2026-07-31T22:00:00.000Z" },
    ]);
    expect(summary.limits.map(({ used, remaining }) => ({ used, remaining }))).toEqual([
      { used: 2, remaining: null },
      { used: 2, remaining: 3 },
    ]);
  });

  it("resets at midnight in Paris, not at midnight UTC", async () => {
    // 31/10 23:30 UTC = 1er/11 00:30 à Paris (heure d'hiver) : le compteur de novembre a commencé.
    const november = await getPlanUsageSummary({
      auth: accountReadingUsage().auth,
      plan,
      now: new Date("2026-10-31T23:30:00.000Z"),
    });
    expect(november).toMatchObject({
      periodStart: "2026-10-31T23:00:00.000Z",
      periodEnd: "2026-11-30T23:00:00.000Z",
    });
    // 30/11 23:30 UTC = 1er/12 00:30 à Paris.
    const december = await getPlanUsageSummary({
      auth: accountReadingUsage().auth,
      plan,
      now: new Date("2026-11-30T23:30:00.000Z"),
    });
    expect(december.periodStart).toBe("2026-11-30T23:00:00.000Z");
  });

  it("reports remaining quota without going negative", () => {
    const limited = buildUsageLimitState({
      eventKey: "property_report.created",
      label: "Rapports générés",
      used: 7,
      limit: 5,
      periodStart: "2026-07-01T00:00:00.000Z",
      periodEnd: "2026-08-01T00:00:00.000Z",
    });
    const unlimited = buildUsageLimitState({
      eventKey: "property_report.pdf_exported",
      label: "Exports PDF",
      used: 42,
      limit: null,
      periodStart: "2026-07-01T00:00:00.000Z",
      periodEnd: "2026-08-01T00:00:00.000Z",
    });

    expect(limited.remaining).toBe(0);
    expect(unlimited.remaining).toBeNull();
  });
});

describe("recordFeatureUsageEvent", () => {
  const event = {
    auth: { userId: "user-1" },
    eventKey: "sales.favorite_added" as const,
    subjectType: "sale",
    subjectId: "sale-1",
    metadata: { source: "favorites_api", skipped: undefined },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.insert.mockResolvedValue({ error: null });
  });

  it("writes the event once the response is sent, inside a request", async () => {
    mocks.after.mockImplementation(() => undefined);

    expect(recordFeatureUsageEvent(event)).toBeUndefined();
    expect(mocks.insert).not.toHaveBeenCalled();

    await mocks.after.mock.calls[0][0]();
    expect(mocks.insert).toHaveBeenCalledWith({
      user_id: "user-1",
      event_key: "sales.favorite_added",
      quantity: 1,
      subject_type: "sale",
      subject_id: "sale-1",
      metadata: { source: "favorites_api" },
    });
  });

  it("writes the event at once outside a request, without being awaited", () => {
    mocks.after.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope.");
    });

    recordFeatureUsageEvent(event);

    expect(mocks.insert).toHaveBeenCalledTimes(1);
  });

  it("logs a failed write instead of throwing it", async () => {
    mocks.after.mockImplementation(() => undefined);
    mocks.insert.mockResolvedValue({ error: { message: "insert failed" } });

    recordFeatureUsageEvent(event);
    await expect(mocks.after.mock.calls[0][0]()).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("record_failed"));
  });
});
