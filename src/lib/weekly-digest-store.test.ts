import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data: unknown; error: unknown };

const state = vi.hoisted(() => ({
  results: {} as Record<string, Result[]>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  rpc: vi.fn(),
  visible: vi.fn(),
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
    "or",
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
vi.mock("@/lib/email-alerts", () => ({ readUserEmail: vi.fn() }));

import { createSupabaseWeeklyDigestStore } from "@/lib/weekly-digest-store";

const USER = "7d335032-e935-4550-9347-ed22b0f63449";
const OTHER = "0a0a0a0a-0000-4000-8000-000000000002";

function callsOf(table: string, method: string) {
  return state.calls.filter((call) => call.table === table && call.method === method);
}

beforeEach(() => {
  state.results = {};
  state.calls = [];
  state.rpc.mockReset();
  state.visible.mockReset();
});

describe("magasin du récapitulatif hebdomadaire", () => {
  it("ne lit que les consentements actifs, datés par la base ET versionnés, avec le jour choisi", async () => {
    state.results.user_notification_preferences = [
      {
        data: [
          { user_id: "a", weekly_digest_weekday: 2 },
          { user_id: "b", weekly_digest_weekday: 5 },
        ],
        error: null,
      },
    ];
    const users = await createSupabaseWeeklyDigestStore().listConsentingUsers();
    expect(users).toEqual([
      { userId: "a", weekday: 2 },
      { userId: "b", weekday: 5 },
    ]);
    expect(callsOf("user_notification_preferences", "eq")[0].args).toEqual([
      "weekly_digest_enabled",
      true,
    ]);
    expect(callsOf("user_notification_preferences", "not").map((call) => call.args)).toEqual([
      ["weekly_digest_consented_at", "is", null],
      ["weekly_digest_consent_text_version", "is", null],
    ]);
  });

  it("échoue plutôt que de conclure à l'absence de consentement quand la lecture échoue", async () => {
    state.results.user_notification_preferences = [{ data: null, error: new Error("injoignable") }];
    await expect(createSupabaseWeeklyDigestStore().listConsentingUsers()).rejects.toThrow(
      "injoignable",
    );
  });

  it("repère les comptes déjà écrits aujourd'hui : alertes, rappels et alertes de résultat", async () => {
    state.results.user_alert_notifications = [{ data: [{ user_id: USER }], error: null }];
    state.results.sale_reminder_dispatches = [{ data: [], error: null }];
    state.results.sale_result_dispatches = [{ data: [{ user_id: OTHER }], error: null }];
    const emailed = await createSupabaseWeeklyDigestStore().usersEmailedSince(
      [USER, OTHER, "c"],
      new Date("2026-11-02T23:00:00Z"),
    );
    expect([...emailed].sort()).toEqual([OTHER, USER].sort());
    expect(callsOf("user_alert_notifications", "eq").map((call) => call.args)).toEqual([
      ["delivery_channel", "email"],
      ["delivery_status", "sent"],
    ]);
    expect(callsOf("sale_reminder_dispatches", "eq")[0].args).toEqual(["status", "sent"]);
    expect(callsOf("sale_result_dispatches", "eq")[0].args).toEqual(["status", "sent"]);
    for (const table of [
      "user_alert_notifications",
      "sale_reminder_dispatches",
      "sale_result_dispatches",
    ]) {
      expect(callsOf(table, "gte")[0].args).toEqual(["sent_at", "2026-11-02T23:00:00.000Z"]);
    }
  });

  it("échoue quand une des lectures « déjà écrit aujourd'hui » échoue", async () => {
    state.results.sale_result_dispatches = [{ data: null, error: new Error("injoignable") }];
    await expect(
      createSupabaseWeeklyDigestStore().usersEmailedSince([USER], new Date()),
    ).rejects.toThrow("injoignable");
  });

  it("repère les semaines servies : envoyées ou aux trois essais épuisés, pour ces comptes et semaines", async () => {
    state.results.weekly_digest_dispatches = [
      {
        data: [
          { user_id: USER, week_key: "2026-W45" },
          { user_id: USER, week_key: "2026-W44" },
        ],
        error: null,
      },
    ];
    const settled = await createSupabaseWeeklyDigestStore().settledDigests([
      { userId: USER, weekKey: "2026-W45" },
      { userId: OTHER, weekKey: "2026-W45" },
    ]);
    // La ligne d'une autre semaine que celles demandées n'est pas prise pour la semaine courante.
    expect([...settled]).toEqual([`${USER}|2026-W45`]);
    expect(callsOf("weekly_digest_dispatches", "or")[0].args).toEqual([
      "status.eq.sent,attempts.gte.3",
    ]);
  });

  it("lit tous les événements de changement non masqués des ventes suivies", async () => {
    state.results.user_sale_change_events = [{ data: [], error: null }];
    await createSupabaseWeeklyDigestStore().recentChangeEvents(
      USER,
      ["s1"],
      new Date("2026-10-27T10:30:00Z"),
    );
    expect(callsOf("user_sale_change_events", "eq")[0].args).toEqual(["user_id", USER]);
    expect(callsOf("user_sale_change_events", "is")[0].args).toEqual(["dismissed_at", null]);
    // Pas de filtre sur le type : tous ceux que montre « Mes favoris ».
    expect(callsOf("user_sale_change_events", "in").map((call) => call.args[0])).toEqual([
      "sale_id",
    ]);
  });

  it("dit si le compte a une alerte active et dans quels départements, sans doublon", async () => {
    state.results.user_alerts = [
      {
        data: [
          { department: "33" },
          { department: " 33 " },
          { department: null },
          { department: "75" },
        ],
        error: null,
      },
    ];
    expect(await createSupabaseWeeklyDigestStore().alertScope(USER)).toEqual({
      hasActiveAlert: true,
      departments: ["33", "75"],
    });
    expect(callsOf("user_alerts", "eq").map((call) => call.args)).toEqual([
      ["user_id", USER],
      ["is_active", true],
    ]);
    state.results.user_alerts = [{ data: [], error: null }];
    expect(await createSupabaseWeeklyDigestStore().alertScope(USER)).toEqual({
      hasActiveAlert: false,
      departments: [],
    });
    // Une alerte sans département reste une alerte : pas de bouton « Créer une alerte ».
    state.results.user_alerts = [{ data: [{ department: null }], error: null }];
    expect(await createSupabaseWeeklyDigestStore().alertScope(USER)).toEqual({
      hasActiveAlert: true,
      departments: [],
    });
  });

  it("compte les nouvelles ventes visibles du département, les plus récentes d'abord", async () => {
    state.results.v_auction_sales_app = [
      {
        data: [
          { id: "n1", property_type: "house", city: "Pessac", department: "33", created_at: "x" },
          {
            id: "n2",
            property_type: "apartment",
            city: "Mérignac",
            department: "33",
            created_at: "y",
          },
          { id: "n3", property_type: "house", city: "Bordeaux", department: "33", created_at: "z" },
        ],
        error: null,
      },
    ];
    state.visible.mockResolvedValue(new Set(["n1", "n3"]));
    const found = await createSupabaseWeeklyDigestStore().newSalesIn(
      ["33"],
      new Date("2026-10-27T10:30:00Z"),
      1,
    );
    expect(found.total).toBe(2);
    expect(found.sales).toEqual([
      { id: "n1", propertyType: "house", city: "Pessac", department: "33" },
    ]);
    expect(state.visible).toHaveBeenCalledWith(["n1", "n2", "n3"]);
    expect(callsOf("v_auction_sales_app", "in")[0].args).toEqual(["department", ["33"]]);
    expect(callsOf("v_auction_sales_app", "gte")[0].args).toEqual([
      "created_at",
      "2026-10-27T10:30:00.000Z",
    ]);
    expect(callsOf("v_auction_sales_app", "order")[0].args).toEqual([
      "created_at",
      { ascending: false },
    ]);
    // Sans département, rien n'est lu.
    state.calls = [];
    expect(await createSupabaseWeeklyDigestStore().newSalesIn([], new Date(), 5)).toEqual({
      total: 0,
      sales: [],
    });
    expect(state.calls).toHaveLength(0);
  });

  it("réserve par la fonction du journal et ne garde au journal qu'un code d'erreur", async () => {
    state.rpc.mockResolvedValue({ data: "row-1", error: null });
    const store = createSupabaseWeeklyDigestStore();
    expect(
      await store.claim({
        userId: USER,
        weekKey: "2026-W45",
        mode: "on",
        payload: { audiences: 1, changes: 0, newSales: 2, hasAlert: true },
      }),
    ).toBe("row-1");
    expect(state.rpc).toHaveBeenCalledWith("claim_weekly_digest", {
      p_user_id: USER,
      p_week_key: "2026-W45",
      p_mode: "on",
      p_payload: { audiences: 1, changes: 0, newSales: 2, hasAlert: true },
    });
    state.rpc.mockResolvedValue({ data: null, error: null });
    expect(
      await store.claim({ userId: USER, weekKey: "2026-W45", mode: "on", payload: {} }),
    ).toBeNull();
    await store.markSent("row-1", { messageId: "msg_1", at: new Date("2026-11-03T10:30:00Z") });
    await store.markFailed("row-1", { error: "send_failed" });
    const updates = callsOf("weekly_digest_dispatches", "update").map((call) => call.args[0]);
    expect(updates[0]).toMatchObject({ status: "sent", message_id: "msg_1", error: null });
    expect(updates[1]).toMatchObject({ status: "failed", error: "send_failed" });
  });
});
