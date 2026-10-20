import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  tables: {} as Record<string, Row[]>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  error: null as { message: string } | null,
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/integrations/supabase/client.server", () => {
  function table(name: string) {
    let window: [number, number] | null = null;
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "gte", "lte", "order"]) {
      query[method] = (...args: unknown[]) => {
        mocks.calls.push({ table: name, method, args });
        return query;
      };
    }
    query.range = (from: number, to: number) => {
      window = [from, to];
      return query;
    };
    query.then = (resolve: (value: { data: Row[] | null; error: unknown }) => unknown) => {
      const rows = mocks.tables[name] ?? [];
      return resolve({
        data: window ? rows.slice(window[0], window[1] + 1) : rows,
        error: mocks.error,
      });
    };
    return query;
  }
  return { supabaseAdmin: { from: table } };
});

import {
  REMINDER_ACCURACY_MAX_RATE,
  REMINDER_ACCURACY_MIN_SAMPLE,
  computeSaleReminderAccuracy,
  getAdminSaleReminderAccuracy,
  loadSaleReminderAccuracy,
  type AudienceChangeSample,
  type SaleReminderDispatchSample,
} from "./admin-pilotage";

const NOW = new Date("2026-11-20T08:00:00Z");
const HOUR = 3_600_000;
const sentAt = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();

function dispatches(count: number, hoursAgo = 100): SaleReminderDispatchSample[] {
  return Array.from({ length: count }, (_, index) => ({
    userId: `user-${index}`,
    saleId: `sale-${index}`,
    sentAt: sentAt(hoursAgo),
  }));
}

/** Changement de date vers un autre jour, détecté `hoursAfterSend` heures après un envoi à `hoursAgo`. */
function dateChange(
  index: number,
  { hoursAgo = 100, hoursAfterSend = 10 } = {},
): AudienceChangeSample {
  return {
    userId: `user-${index}`,
    saleId: `sale-${index}`,
    detectedAt: sentAt(hoursAgo - hoursAfterSend),
    previousDate: "2026-12-01T13:00:00Z",
    currentDate: "2026-12-15T13:00:00Z",
  };
}

describe("computeSaleReminderAccuracy", () => {
  it("compte les rappels contredits par un changement de date dans les 72 h", () => {
    const result = computeSaleReminderAccuracy({
      dispatches: dispatches(200),
      changes: [dateChange(0), dateChange(1, { hoursAfterSend: 72 })],
      now: NOW,
    });
    expect(result).toMatchObject({
      measuredReminders: 200,
      contradictedReminders: 2,
      contradictionRate: 0.01,
      minimumSample: REMINDER_ACCURACY_MIN_SAMPLE,
      maxRate: REMINDER_ACCURACY_MAX_RATE,
      verdict: "met",
    });
  });

  it("ne compte pas un changement tardif (plus de 72 h), antérieur à l'envoi ou d'une autre vente", () => {
    const result = computeSaleReminderAccuracy({
      dispatches: dispatches(120, 200),
      changes: [
        dateChange(0, { hoursAgo: 200, hoursAfterSend: 73 }),
        dateChange(1, { hoursAgo: 200, hoursAfterSend: -5 }),
        { ...dateChange(2, { hoursAgo: 200 }), saleId: "autre-vente" },
        { ...dateChange(3, { hoursAgo: 200 }), userId: "autre-personne" },
      ],
      now: NOW,
    });
    expect(result.contradictedReminders).toBe(0);
    expect(result.contradictionRate).toBe(0);
    expect(result.verdict).toBe("met");
  });

  it("ne compte pas un simple changement d'heure le même jour (Paris)", () => {
    const sameDay = {
      ...dateChange(0),
      previousDate: "2026-12-01T13:00:00Z",
      currentDate: "2026-12-01T09:00:00Z",
    };
    const result = computeSaleReminderAccuracy({
      dispatches: dispatches(100),
      changes: [sameDay],
      now: NOW,
    });
    expect(result.contradictedReminders).toBe(0);
  });

  it("compte un changement de jour civil de Paris, même à quelques heures d'écart UTC", () => {
    // 23 h 30 UTC le 1er = 0 h 30 à Paris le 2 : jour différent de 22 h UTC le 1er (23 h à Paris).
    const acrossMidnight = {
      ...dateChange(0),
      previousDate: "2026-12-01T22:00:00Z",
      currentDate: "2026-12-01T23:30:00Z",
    };
    const result = computeSaleReminderAccuracy({
      dispatches: dispatches(100),
      changes: [acrossMidnight],
      now: NOW,
    });
    expect(result.contradictedReminders).toBe(1);
  });

  it("ne juge pas un rappel dont les 72 h ne sont pas écoulées, ni un rappel hors fenêtre", () => {
    const result = computeSaleReminderAccuracy({
      dispatches: [
        ...dispatches(100, 100),
        { userId: "u", saleId: "recent", sentAt: sentAt(71) },
        { userId: "u", saleId: "ancien", sentAt: sentAt(31 * 24) },
      ],
      changes: [],
      now: NOW,
    });
    expect(result.measuredReminders).toBe(100);
  });

  it("ne conclut pas sous 100 rappels mesurés, même sans aucune contradiction", () => {
    const result = computeSaleReminderAccuracy({
      dispatches: dispatches(REMINDER_ACCURACY_MIN_SAMPLE - 1),
      changes: [],
      now: NOW,
    });
    expect(result.verdict).toBe("insufficient_sample");
    expect(result.contradictionRate).toBe(0);
  });

  it("rend « non mesuré » (null) sans aucun rappel, jamais zéro", () => {
    const result = computeSaleReminderAccuracy({ dispatches: [], changes: [], now: NOW });
    expect(result.contradictionRate).toBeNull();
    expect(result.verdict).toBe("insufficient_sample");
  });

  it("le seuil est strict : exactement 2 % ne passe pas, 1 sur 100 passe", () => {
    const at = (count: number) =>
      computeSaleReminderAccuracy({
        dispatches: dispatches(100),
        changes: Array.from({ length: count }, (_, index) => dateChange(index)),
        now: NOW,
      });
    expect(at(1).verdict).toBe("met");
    expect(at(2).verdict).toBe("not_met");
    expect(at(2).contradictionRate).toBe(0.02);
    expect(at(10).verdict).toBe("not_met");
  });

  it("ne compte qu'une fois un rappel contredit par plusieurs changements", () => {
    const result = computeSaleReminderAccuracy({
      dispatches: dispatches(100),
      changes: [dateChange(0), dateChange(0, { hoursAfterSend: 20 })],
      now: NOW,
    });
    expect(result.contradictedReminders).toBe(1);
  });

  it("ne porte que des nombres, des dates et un verdict : aucune personne", () => {
    const result = computeSaleReminderAccuracy({
      dispatches: dispatches(100),
      changes: [dateChange(0)],
      now: NOW,
    });
    expect(JSON.stringify(result)).not.toMatch(/user-|sale-/);
  });
});

describe("loadSaleReminderAccuracy", () => {
  beforeEach(() => {
    mocks.tables = {};
    mocks.calls = [];
    mocks.error = null;
    mocks.requireAuth.mockReset();
  });

  const callsOf = (table: string, method: string) =>
    mocks.calls.filter((call) => call.table === table && call.method === method);

  it("lit les rappels J-7 et J-1 envoyés et les changements de date, puis calcule le taux", async () => {
    mocks.tables.sale_reminder_dispatches = Array.from({ length: 100 }, (_, index) => ({
      user_id: `user-${index}`,
      sale_id: `sale-${index}`,
      sent_at: sentAt(100),
    }));
    mocks.tables.user_sale_change_events = [
      {
        user_id: "user-0",
        sale_id: "sale-0",
        detected_at: sentAt(90),
        change_summary: {
          field: "saleDate",
          previousValue: "2026-12-01T13:00:00Z",
          currentValue: "2026-12-15T13:00:00Z",
        },
      },
    ];
    const result = await loadSaleReminderAccuracy(NOW);
    expect(result).toMatchObject({
      measuredReminders: 100,
      contradictedReminders: 1,
      contradictionRate: 0.01,
      verdict: "met",
    });
    expect(callsOf("sale_reminder_dispatches", "eq")[0].args).toEqual(["status", "sent"]);
    expect(callsOf("sale_reminder_dispatches", "in")[0].args).toEqual([
      "reminder_kind",
      ["audience_j7", "audience_j1"],
    ]);
    expect(callsOf("user_sale_change_events", "eq")[0].args).toEqual([
      "event_kind",
      "audience_changed",
    ]);
  });

  it("rend « non mesuré » quand une lecture est tronquée, jamais une mesure partielle", async () => {
    mocks.tables.sale_reminder_dispatches = Array.from({ length: 20_000 }, (_, index) => ({
      user_id: `u${index}`,
      sale_id: `s${index}`,
      sent_at: sentAt(100),
    }));
    const result = await loadSaleReminderAccuracy(NOW);
    expect(result).toMatchObject({
      measuredReminders: null,
      contradictedReminders: null,
      contradictionRate: null,
      verdict: "unavailable",
    });
  });

  it("échoue quand la base répond par une erreur, au lieu de conclure à zéro", async () => {
    mocks.error = { message: "injoignable" };
    await expect(loadSaleReminderAccuracy(NOW)).rejects.toMatchObject({ message: "injoignable" });
  });

  it("refuse un compte qui n'est pas administrateur, avant toute lecture", async () => {
    mocks.requireAuth.mockResolvedValueOnce({ isAdmin: false });
    await expect(getAdminSaleReminderAccuracy("jeton", NOW)).rejects.toThrow(/Forbidden/);
    expect(mocks.calls).toEqual([]);
  });

  it("lit pour un administrateur", async () => {
    mocks.requireAuth.mockResolvedValueOnce({ isAdmin: true });
    const result = await getAdminSaleReminderAccuracy("jeton", NOW);
    expect(result.verdict).toBe("insufficient_sample");
    expect(mocks.requireAuth).toHaveBeenCalledWith("jeton");
  });
});
