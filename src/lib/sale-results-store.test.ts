import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data: unknown; error: unknown };

const state = vi.hoisted(() => ({
  results: {} as Record<string, Result[]>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  rpc: vi.fn(),
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
vi.mock("@/lib/sale-publication-guard", () => ({ getPublicationVisibleSaleIds: vi.fn() }));
vi.mock("@/lib/email-alerts", () => ({ readUserEmail: vi.fn() }));

import { createSupabaseSaleResultStore } from "@/lib/sale-results-store";

const USER = "7d335032-e935-4550-9347-ed22b0f63449";
const SALE = "11111111-0000-4000-8000-000000000001";

function callsOf(table: string, method: string) {
  return state.calls.filter((call) => call.table === table && call.method === method);
}

beforeEach(() => {
  state.results = {};
  state.calls = [];
  state.rpc.mockReset();
});

describe("magasin des alertes de résultat", () => {
  it("ne lit que les consentements actifs, datés par la base ET versionnés", async () => {
    state.results.user_notification_preferences = [
      { data: [{ user_id: "a" }, { user_id: "b" }], error: null },
    ];
    const ids = await createSupabaseSaleResultStore().listConsentingUserIds();
    expect(ids).toEqual(["a", "b"]);
    expect(callsOf("user_notification_preferences", "eq")[0].args).toEqual([
      "sale_results_enabled",
      true,
    ]);
    expect(callsOf("user_notification_preferences", "not").map((call) => call.args)).toEqual([
      ["sale_results_consented_at", "is", null],
      ["sale_results_consent_text_version", "is", null],
    ]);
  });

  it("échoue plutôt que de conclure à l'absence de consentement quand la lecture échoue", async () => {
    state.results.user_notification_preferences = [{ data: null, error: new Error("injoignable") }];
    await expect(createSupabaseSaleResultStore().listConsentingUserIds()).rejects.toThrow(
      "injoignable",
    );
  });

  it("lit les instantanés sans aucune colonne de prix", async () => {
    state.results.user_followed_sale_snapshots = [
      {
        data: [
          {
            sale_id: SALE,
            captured_at: "2026-11-03T14:00:00Z",
            result_status: "adjudicated",
            sale_date: "2026-11-03T13:00:00Z",
            sale_venue_type: "tribunal",
            city: "Bordeaux",
            property_type: "house",
            tribunal_name: "TJ Bordeaux",
          },
          { sale_id: "s2", captured_at: "x", result_status: "n'importe quoi" },
        ],
        error: null,
      },
    ];
    const snapshots = await createSupabaseSaleResultStore().recentSnapshots(
      USER,
      new Date("2026-10-28T10:00:00Z"),
    );
    const selected = String(callsOf("user_followed_sale_snapshots", "select")[0].args[0]);
    expect(selected).not.toMatch(/price|prix|ceiling/i);
    expect(callsOf("user_followed_sale_snapshots", "eq")[0].args).toEqual(["user_id", USER]);
    expect(callsOf("user_followed_sale_snapshots", "gte")[0].args).toEqual([
      "captured_at",
      "2026-10-28T10:00:00.000Z",
    ]);
    expect(snapshots[0]).toEqual({
      saleId: SALE,
      capturedAt: "2026-11-03T14:00:00Z",
      resultStatus: "adjudicated",
      saleDate: "2026-11-03T13:00:00Z",
      venueType: "tribunal",
      city: "Bordeaux",
      propertyType: "house",
      tribunalName: "TJ Bordeaux",
    });
    // Un statut inconnu de la liste fermée vaut « résultat inconnu », jamais « adjugé ».
    expect(snapshots[1].resultStatus).toBe("unknown");
  });

  it("repère un avertissement déjà journalisé par les rappels pour le même statut", async () => {
    state.results.sale_reminder_dispatches = [
      { data: [{ id: "r1" }], error: null },
      { data: [], error: null },
    ];
    const store = createSupabaseSaleResultStore();
    expect(await store.reminderWarningExists(USER, SALE, "withdrawn")).toBe(true);
    expect(await store.reminderWarningExists(USER, SALE, "adjudicated")).toBe(false);
    expect(
      callsOf("sale_reminder_dispatches", "eq")
        .slice(0, 4)
        .map((call) => call.args),
    ).toEqual([
      ["user_id", USER],
      ["sale_id", SALE],
      ["reminder_kind", "status_changed"],
      ["payload->>currentValue", "withdrawn"],
    ]);
  });

  it("réserve par la fonction du journal, avec le mode et un payload sans prix", async () => {
    state.rpc.mockResolvedValue({ data: "row-1", error: null });
    const id = await createSupabaseSaleResultStore().claim({
      userId: USER,
      saleId: SALE,
      kind: "result_known",
      mode: "on",
      payload: { origin: "snapshot", result: "adjudicated" },
    });
    expect(id).toBe("row-1");
    expect(state.rpc).toHaveBeenCalledWith("claim_sale_result", {
      p_user_id: USER,
      p_sale_id: SALE,
      p_kind: "result_known",
      p_mode: "on",
      p_payload: { origin: "snapshot", result: "adjudicated" },
    });
    state.rpc.mockResolvedValue({ data: null, error: null });
    expect(
      await createSupabaseSaleResultStore().claim({
        userId: USER,
        saleId: SALE,
        kind: "relisted",
        mode: "internal",
        payload: {},
      }),
    ).toBeNull();
  });

  it("marque envoyé avec l'identifiant du message, et échoué avec un code, jamais un texte", async () => {
    const store = createSupabaseSaleResultStore();
    await store.markSent(["r1", "r2"], {
      messageId: "msg_1",
      at: new Date("2026-11-04T10:15:00Z"),
    });
    await store.markFailed(["r1"], { error: "send_failed" });
    const updates = callsOf("sale_result_dispatches", "update").map((call) => call.args[0]);
    expect(updates[0]).toMatchObject({ status: "sent", message_id: "msg_1", error: null });
    expect(updates[1]).toMatchObject({ status: "failed", error: "send_failed" });
    expect(callsOf("sale_result_dispatches", "in").map((call) => call.args)).toEqual([
      ["id", ["r1", "r2"]],
      ["id", ["r1"]],
    ]);
  });
});
