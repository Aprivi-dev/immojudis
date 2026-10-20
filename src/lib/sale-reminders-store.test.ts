import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data: unknown; error: unknown };

const state = vi.hoisted(() => ({
  results: {} as Record<string, Result[]>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  rpc: vi.fn(),
  visible: vi.fn(),
  readUserEmail: vi.fn(),
}));

/** Constructeur de requête qui note chaque appel et rend les résultats prévus, table par table. */
function builder(table: string) {
  const self: Record<string, unknown> = {};
  for (const method of [
    "select",
    "eq",
    "not",
    "in",
    "gte",
    "is",
    "order",
    "range",
    "limit",
    "update",
  ]) {
    self[method] = (...args: unknown[]) => {
      state.calls.push({ table, method, args });
      return self;
    };
  }
  self.then = (resolve: (value: Result) => unknown) =>
    resolve(state.results[table]?.shift() ?? { data: [], error: null });
  return self;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (table: string) => builder(table), rpc: state.rpc },
}));
vi.mock("@/lib/sale-publication-guard", () => ({ getPublicationVisibleSaleIds: state.visible }));
vi.mock("@/lib/email-alerts", () => ({ readUserEmail: state.readUserEmail }));

import {
  createSupabaseSaleReminderStore,
  latestSourceVerification,
} from "@/lib/sale-reminders-store";

const USER = "7d335032-e935-4550-9347-ed22b0f63449";

function callsOf(table: string, method: string) {
  return state.calls.filter((call) => call.table === table && call.method === method);
}

beforeEach(() => {
  state.results = {};
  state.calls = [];
  state.rpc.mockReset();
  state.visible.mockReset();
  state.readUserEmail.mockReset();
});

describe("magasin des rappels d'audience", () => {
  it("ne lit que les personnes ayant un consentement actif et daté", async () => {
    state.results.user_notification_preferences = [
      { data: [{ user_id: "a" }, { user_id: "b" }], error: null },
    ];
    const ids = await createSupabaseSaleReminderStore().listConsentingUserIds();
    expect(ids).toEqual(["a", "b"]);
    expect(callsOf("user_notification_preferences", "eq")[0].args).toEqual([
      "sale_reminders_enabled",
      true,
    ]);
    expect(callsOf("user_notification_preferences", "not")[0].args).toEqual([
      "sale_reminders_consented_at",
      "is",
      null,
    ]);
  });

  it("lit les consentements page par page", async () => {
    const page = Array.from({ length: 1_000 }, (_, index) => ({ user_id: `u${index}` }));
    state.results.user_notification_preferences = [
      { data: page, error: null },
      { data: [{ user_id: "dernier" }], error: null },
    ];
    const ids = await createSupabaseSaleReminderStore().listConsentingUserIds();
    expect(ids).toHaveLength(1_001);
    expect(callsOf("user_notification_preferences", "range").map((call) => call.args)).toEqual([
      [0, 999],
      [1_000, 1_999],
    ]);
  });

  it("échoue plutôt que de conclure à l'absence de consentement quand la lecture échoue", async () => {
    state.results.user_notification_preferences = [{ data: null, error: new Error("injoignable") }];
    await expect(createSupabaseSaleReminderStore().listConsentingUserIds()).rejects.toThrow(
      "injoignable",
    );
  });

  it("reconnaît les administrateurs parmi les personnes ayant consenti", async () => {
    state.results.user_profiles = [{ data: [{ user_id: "b" }], error: null }];
    const admins = await createSupabaseSaleReminderStore().filterAdminUserIds(["a", "b"]);
    expect([...admins]).toEqual(["b"]);
    expect(callsOf("user_profiles", "eq")[0].args).toEqual(["user_role", "admin"]);
  });

  it("suit les favoris et les ventes débloquées, sans doublon, avec leur date stockée", async () => {
    state.results.user_favorites = [{ data: [{ sale_id: "s1" }, { sale_id: "s2" }], error: null }];
    state.results.user_sale_unlocks = [
      { data: [{ sale_id: "s2" }, { sale_id: "s3" }], error: null },
    ];
    state.results.auction_sales = [
      {
        data: [
          { id: "s1", sale_date: "2026-11-10T13:00:00Z" },
          { id: "s2", sale_date: null },
          { id: "s3", sale_date: "2026-12-01T09:00:00Z" },
        ],
        error: null,
      },
    ];
    const sales = await createSupabaseSaleReminderStore().followedSales(USER);
    expect(sales).toEqual([
      { id: "s1", saleDate: "2026-11-10T13:00:00Z" },
      { id: "s2", saleDate: null },
      { id: "s3", saleDate: "2026-12-01T09:00:00Z" },
    ]);
    expect(callsOf("auction_sales", "in")[0].args).toEqual(["id", ["s1", "s2", "s3"]]);
    // Une vente débloquée dont la fiche a été purgée (sale_id nul) n'est pas suivie.
    expect(callsOf("user_sale_unlocks", "not")[0].args).toEqual(["sale_id", "is", null]);
  });

  it("lit tous les favoris et toutes les ventes débloquées, page par page, sans plafond de 500", async () => {
    const page = Array.from({ length: 1_000 }, (_, index) => ({ sale_id: `f${index}` }));
    state.results.user_favorites = [
      { data: page, error: null },
      { data: [{ sale_id: "dernier" }], error: null },
    ];
    state.results.user_sale_unlocks = [{ data: [{ sale_id: "f0" }], error: null }];
    await createSupabaseSaleReminderStore().followedSales(USER);
    expect(callsOf("user_favorites", "range").map((call) => call.args)).toEqual([
      [0, 999],
      [1_000, 1_999],
    ]);
    expect(callsOf("user_favorites", "limit")).toEqual([]);
    expect(callsOf("user_sale_unlocks", "limit")).toEqual([]);
    const ids = callsOf("auction_sales", "in").flatMap((call) => call.args[1] as string[]);
    expect(ids).toHaveLength(1_001);
  });

  it("lit la dernière vérification à la source : last_seen_at et contrôles de source", async () => {
    state.results.auction_sales = [
      {
        data: [
          {
            id: "s1",
            last_seen_at: "2026-11-02T10:00:00Z",
            source_checks: { a: { checked_at: "2026-11-03T02:00:00Z" } },
          },
          { id: "s2", last_seen_at: null, source_checks: null },
        ],
        error: null,
      },
    ];
    const verified = await createSupabaseSaleReminderStore().lastVerifiedAt(["s1", "s2"]);
    expect([...verified]).toEqual([
      ["s1", "2026-11-03T02:00:00.000Z"],
      ["s2", null],
    ]);
    expect(callsOf("auction_sales", "select")[0].args[0]).toContain("last_seen_at");
    expect(callsOf("auction_sales", "select")[0].args[0]).toContain("raw_payload->source_checks");
  });

  it("échoue plutôt que de conclure qu'une vente est fraîche quand la lecture échoue", async () => {
    state.results.auction_sales = [{ data: null, error: new Error("injoignable") }];
    await expect(createSupabaseSaleReminderStore().lastVerifiedAt(["s1"])).rejects.toThrow(
      "injoignable",
    );
  });

  it("ne lit que les événements de date et de statut récents et non masqués de la personne", async () => {
    state.results.user_sale_change_events = [
      {
        data: [
          {
            id: "e1",
            sale_id: "s1",
            watch_kind: "favorite",
            watch_id: "w1",
            event_kind: "status_changed",
            severity: "urgent",
            fingerprint: "f",
            summary_label: "Statut",
            change_summary: {
              field: "status",
              previousValue: "upcoming",
              currentValue: "postponed",
            },
            detected_at: "2026-11-03T05:00:00Z",
            read_at: null,
            dismissed_at: null,
          },
        ],
        error: null,
      },
    ];
    const since = new Date("2026-10-31T06:00:00Z");
    const events = await createSupabaseSaleReminderStore().recentChangeEvents(USER, ["s1"], since);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      saleId: "s1",
      eventKind: "status_changed",
      fingerprint: "f",
    });
    expect(callsOf("user_sale_change_events", "eq")[0].args).toEqual(["user_id", USER]);
    expect(callsOf("user_sale_change_events", "in")[0].args).toEqual([
      "event_kind",
      ["audience_changed", "status_changed"],
    ]);
    expect(callsOf("user_sale_change_events", "gte")[0].args).toEqual([
      "detected_at",
      since.toISOString(),
    ]);
    expect(callsOf("user_sale_change_events", "is")[0].args).toEqual(["dismissed_at", null]);
  });

  it("réserve un rappel par la fonction du journal et rend null s'il a déjà été traité", async () => {
    state.rpc.mockResolvedValueOnce({ data: "journal-1", error: null });
    state.rpc.mockResolvedValueOnce({ data: null, error: null });
    const store = createSupabaseSaleReminderStore();
    const args = {
      userId: USER,
      saleId: "s1",
      kind: "audience_j7" as const,
      dedupeKey: "2026-11-10",
      mode: "on" as const,
      payload: { headline: "Votre audience est dans 7 jours" },
    };
    expect(await store.claim(args)).toBe("journal-1");
    expect(await store.claim(args)).toBeNull();
    expect(state.rpc).toHaveBeenCalledWith("claim_sale_reminder", {
      p_user_id: USER,
      p_sale_id: "s1",
      p_kind: "audience_j7",
      p_key: "2026-11-10",
      p_mode: "on",
      p_payload: { headline: "Votre audience est dans 7 jours" },
    });
  });

  it("lit la date publique d'une vente (première ligne de la fonction publique)", async () => {
    state.rpc.mockResolvedValueOnce({ data: [{ id: "s1", exportable: true }], error: null });
    state.rpc.mockResolvedValueOnce({ data: [], error: null });
    const store = createSupabaseSaleReminderStore();
    expect(await store.calendarEvent("s1")).toMatchObject({ id: "s1", exportable: true });
    expect(state.rpc).toHaveBeenCalledWith("get_public_sale_calendar_event", { p_sale_id: "s1" });
    expect(await store.calendarEvent("s2")).toBeNull();
  });

  it("note l'envoi ou l'échec sur les lignes du journal", async () => {
    const store = createSupabaseSaleReminderStore();
    await store.markSent(["j1", "j2"], {
      messageId: "msg_1",
      at: new Date("2026-11-03T06:00:00Z"),
    });
    const sent = callsOf("sale_reminder_dispatches", "update")[0].args[0] as Record<
      string,
      unknown
    >;
    expect(sent).toMatchObject({ status: "sent", message_id: "msg_1", error: null });
    expect(callsOf("sale_reminder_dispatches", "in")[0].args).toEqual(["id", ["j1", "j2"]]);

    await store.markFailed(["j1"], { error: "send_failed" });
    const failed = callsOf("sale_reminder_dispatches", "update")[1].args[0] as Record<
      string,
      unknown
    >;
    expect(failed).toMatchObject({ status: "failed", error: "send_failed" });

    state.calls = [];
    await store.markSent([], { messageId: null, at: new Date() });
    await store.markFailed([], { error: "send_failed" });
    expect(state.calls).toEqual([]);
  });

  it("purge le journal par la fonction dédiée", async () => {
    state.rpc.mockResolvedValueOnce({ data: 7, error: null });
    expect(await createSupabaseSaleReminderStore().purgeJournal()).toBe(7);
    expect(state.rpc).toHaveBeenCalledWith("purge_sale_reminder_dispatches");
  });

  it("s'appuie sur la garde de publication et sur la lecture de l'adresse email existantes", async () => {
    state.visible.mockResolvedValueOnce(new Set(["s1"]));
    state.readUserEmail.mockResolvedValueOnce("a@example.test");
    const store = createSupabaseSaleReminderStore();
    expect([...(await store.visibleSaleIds(["s1", "s2"]))]).toEqual(["s1"]);
    expect(await store.userEmail(USER)).toBe("a@example.test");
  });
});

describe("latestSourceVerification", () => {
  it("garde la date la plus récente, ignore ce qui n'est pas une date", () => {
    expect(
      latestSourceVerification({
        last_seen_at: "2026-11-01T00:00:00Z",
        source_checks: {
          a: { checked_at: "2026-11-02T00:00:00Z" },
          b: { checked_at: "pas une date" },
          c: null,
          d: { fingerprint: "x" },
        },
      }),
    ).toBe("2026-11-02T00:00:00.000Z");
    expect(latestSourceVerification({ last_seen_at: "2026-11-01T00:00:00Z" })).toBe(
      "2026-11-01T00:00:00.000Z",
    );
    expect(latestSourceVerification({ source_checks: [] })).toBeNull();
    expect(latestSourceVerification({})).toBeNull();
  });
});
