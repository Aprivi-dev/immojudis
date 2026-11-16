import { AdminRequiredError } from "@/lib/api-errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { privacyDeadlineLabel, privacyDeadlineStatus } from "./privacy-deadline";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "99999999-9999-4999-8999-999999999999";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => ({
  requestRow: {} as Record<string, unknown>,
  role: "user",
  customerId: "cus_123" as string | null,
  subscription: null as Record<string, unknown> | null,
  searchedCustomers: [] as Array<{ id: string }>,
  credits: { data: 0, error: null } as { data: number | null; error: { code?: string } | null },
  blockingCounts: {} as Record<string, number>,
  recentPurchases: [] as Array<Record<string, unknown>>,
  deletes: [] as Array<{ table: string; column: string; value: string }>,
  deleteErrors: {} as Record<string, { code?: string; message?: string }>,
  updates: [] as Array<Record<string, unknown>>,
  metadataUpdates: [] as Array<Record<string, unknown>>,
  order: [] as string[],
  deleteUser: vi.fn(),
  stripeDel: vi.fn(),
  stripeSearch: vi.fn(),
  storageList: vi.fn(),
  storageRemove: vi.fn(),
  notifyClosed: vi.fn(),
}));

vi.mock("@/lib/billing-stripe", () => ({
  getStripe: () => ({ customers: { del: state.stripeDel } }),
  findStripeCustomersOfAccount: state.stripeSearch,
}));
vi.mock("@/lib/privacy-request-notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/privacy-request-notifications")>()),
  notifyPrivacyRequestClosed: state.notifyClosed,
  notifyPrivacyRequestReceived: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    auth: { admin: { deleteUser: state.deleteUser } },
    storage: { from: () => ({ list: state.storageList, remove: state.storageRemove }) },
    rpc: async () => state.credits,
    from(table: string) {
      let mode: "select" | "count" | "delete" | "update" = "select";
      let payload: Record<string, unknown> = {};
      const recordDelete = (column: string, value: string) => {
        state.deletes.push({ table, column, value });
        state.order.push(`delete:${table}`);
        const failure = state.deleteErrors[table];
        if (failure) return Promise.resolve({ count: null, error: failure });
        return Promise.resolve({ count: 1, error: null });
      };
      const builder: Record<string, unknown> = {
        select: (_columns: string, options?: { head?: boolean }) => {
          if (options?.head) mode = "count";
          return builder;
        },
        update: (value: Record<string, unknown>) => {
          mode = "update";
          payload = value;
          return builder;
        },
        delete: () => {
          mode = "delete";
          return builder;
        },
        eq: (column: string, value: string) => {
          if (mode === "delete") return recordDelete(column, value);
          if (mode === "count") {
            return Promise.resolve({ count: state.blockingCounts[table] ?? 0, error: null });
          }
          if (mode === "update" && !("status" in payload)) {
            state.metadataUpdates.push(payload);
            state.order.push("record-start");
            return Promise.resolve({ error: null });
          }
          return builder;
        },
        ilike: (column: string, value: string) => recordDelete(column, value),
        gt: () => builder,
        order: () => builder,
        limit: () => Promise.resolve({ data: state.recentPurchases, error: null }),
        single: async () => {
          if (mode === "update") {
            state.updates.push(payload);
            state.order.push("close-request");
            return { data: { ...state.requestRow, ...payload }, error: null };
          }
          return { data: state.requestRow, error: null };
        },
        maybeSingle: async () => {
          if (table === "user_profiles") return { data: { user_role: state.role }, error: null };
          if (table === "user_subscriptions") {
            return {
              data:
                state.subscription ??
                (state.customerId ? { stripe_customer_id: state.customerId } : null),
              error: null,
            };
          }
          return { data: null, error: null };
        },
      };
      return builder;
    },
  },
}));

import { executePrivacyErasure } from "./privacy-requests";

const admin = { userId: ADMIN_ID, isAdmin: true } as unknown as SupabaseAuthContext;
const input = { requestId: REQUEST_ID, confirmEmail: "Client@Example.test" };

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    request_type: "erasure",
    status: "in_review",
    identity_status: "verified",
    message: null,
    submitted_at: "2026-10-01T10:00:00.000Z",
    acknowledged_at: "2026-10-01T10:00:00.000Z",
    due_at: "2026-11-01T10:00:00.000Z",
    completed_at: null,
    resolution_code: null,
    requester_email: "client@example.test",
    user_id: USER_ID,
    operator_notes: null,
    metadata: { source: "authenticated_rights_portal" },
    ...overrides,
  };
}

describe("erasure execution (P4-10)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state.requestRow = request();
    state.role = "user";
    state.customerId = "cus_123";
    state.subscription = null;
    state.searchedCustomers = [];
    state.credits = { data: 0, error: null };
    state.blockingCounts = {};
    state.recentPurchases = [];
    state.deletes = [];
    state.deleteErrors = {};
    state.updates = [];
    state.metadataUpdates = [];
    state.order = [];
    state.stripeSearch.mockImplementation(async () => state.searchedCustomers);
    state.stripeDel.mockImplementation(async () => {
      state.order.push("stripe");
      return { deleted: true };
    });
    state.deleteUser.mockImplementation(async () => {
      state.order.push("auth-user");
      return { error: null };
    });
    state.storageList.mockResolvedValue({ data: [], error: null });
    state.storageRemove.mockResolvedValue({ error: null });
  });

  it("deletes the Stripe customer, then application data, then the auth user, then closes the request", async () => {
    const report = await executePrivacyErasure({ auth: admin, input });

    expect(state.stripeDel).toHaveBeenCalledWith("cus_123");
    // Le compte visé est gardé dans la demande AVANT toute suppression (reprise F1), puis Stripe d'abord.
    expect(state.order.slice(0, 2)).toEqual(["record-start", "stripe"]);
    expect(state.metadataUpdates[0]).toMatchObject({
      metadata: { erasure: { account_id: USER_ID, started_by: ADMIN_ID } },
    });
    expect(state.order.at(-2)).toBe("auth-user");
    expect(state.order.at(-1)).toBe("close-request");
    expect(state.deleteUser).toHaveBeenCalledWith(USER_ID);
    const tables = state.deletes.map((entry) => entry.table);
    for (const table of [
      "user_alerts",
      "user_favorites",
      "user_followed_sale_snapshots",
      "account_product_events",
      "sale_reminder_dispatches",
      "saved_property_reports",
      "sale_workspaces",
      "user_subscriptions",
      "offer_opening_notifications",
      "user_sale_unlocks",
      "launch_offer_end_notices",
      "launch_offer_end_notice_optouts",
      "email_send_log",
    ]) {
      expect(tables).toContain(table);
    }
    // Chaque suppression vise le compte, sauf celles par adresse (minuscules) : journal des emails et
    // invitations reçues sans compte (M5).
    const byAddress = state.deletes.filter(
      (entry) => entry.column === "to_address" || entry.column === "invited_email",
    );
    expect(byAddress).toEqual([
      { table: "email_send_log", column: "to_address", value: "client@example.test" },
      {
        table: "sale_workspace_collaborators",
        column: "invited_email",
        value: "client@example.test",
      },
    ]);
    expect(
      state.deletes
        .filter((entry) => entry.column !== "to_address" && entry.column !== "invited_email")
        .every((entry) => entry.value === USER_ID),
    ).toBe(true);
    expect(state.deletes.filter((entry) => entry.table === "email_send_log")).toContainEqual({
      table: "email_send_log",
      column: "user_id",
      value: USER_ID,
    });
    // L'adresse est effacée AVANT la suppression du compte, dont elle dépend.
    expect(state.order.lastIndexOf("delete:email_send_log")).toBeLessThan(
      state.order.indexOf("auth-user"),
    );
    expect(report.deletedRows["email_send_log.to_address"]).toBe(1);
    expect(state.updates[0]).toMatchObject({
      status: "completed",
      resolution_code: "erasure_executed",
    });
    expect(report).toMatchObject({ stripeCustomerDeleted: true, authUserDeleted: true });
    expect(report.request.status).toBe("completed");
  });

  describe("a table that cannot be erased fails the erasure, before the auth user is deleted", () => {
    const missing = { code: "PGRST205", message: "Could not find the table in the schema cache" };

    it.each([
      "email_send_log",
      "sale_signal_feedback",
      "weekly_digest_dispatches",
      "sale_result_dispatches",
      "launch_offer_end_notices",
      "launch_offer_end_notice_optouts",
    ])("fails the erasure when %s is missing, and keeps the account", async (table) => {
      state.deleteErrors[table] = missing;
      await expect(executePrivacyErasure({ auth: admin, input })).rejects.toThrow(
        `Erasure failed in ${table}`,
      );
      expect(state.deleteUser).not.toHaveBeenCalled();
    });

    it("fails on the PostgreSQL undefined_table code too", async () => {
      state.deleteErrors.sale_result_dispatches = { code: "42P01", message: "does not exist" };
      await expect(executePrivacyErasure({ auth: admin, input })).rejects.toThrow(
        "Erasure failed in sale_result_dispatches",
      );
      expect(state.deleteUser).not.toHaveBeenCalled();
    });

    it("fails for any other missing table, or any other error", async () => {
      state.deleteErrors.user_alerts = missing;
      await expect(executePrivacyErasure({ auth: admin, input })).rejects.toThrow(
        "Erasure failed in user_alerts",
      );
      expect(state.deleteUser).not.toHaveBeenCalled();

      state.deleteErrors = { sale_signal_feedback: { code: "XX000", message: "boom" } };
      await expect(executePrivacyErasure({ auth: admin, input })).rejects.toThrow(
        "Erasure failed in sale_signal_feedback",
      );
      expect(state.deleteUser).not.toHaveBeenCalled();
    });
  });

  it("keeps the account intact when Stripe fails, so the operation can be retried", async () => {
    state.stripeDel.mockRejectedValue(new Error("stripe down"));

    await expect(executePrivacyErasure({ auth: admin, input })).rejects.toThrow("stripe down");

    expect(state.deletes).toEqual([]);
    expect(state.deleteUser).not.toHaveBeenCalled();
  });

  it("tolerates a Stripe customer that no longer exists", async () => {
    state.stripeDel.mockRejectedValue(
      Object.assign(new Error("gone"), { code: "resource_missing" }),
    );
    const report = await executePrivacyErasure({ auth: admin, input });
    expect(report.stripeCustomerDeleted).toBe(true);
    expect(state.deleteUser).toHaveBeenCalled();
  });

  it("removes uploaded files of the user", async () => {
    state.storageList.mockImplementation(async (prefix: string) =>
      prefix === USER_ID
        ? { data: [{ name: "request-1", id: null }], error: null }
        : { data: [{ name: "acte.pdf", id: "obj-1" }], error: null },
    );
    const report = await executePrivacyErasure({ auth: admin, input });
    expect(state.storageRemove).toHaveBeenCalledWith([`${USER_ID}/request-1/acte.pdf`]);
    expect(report.storageObjectsRemoved).toBe(1);
  });

  it.each([
    [
      "a non-admin caller",
      () => ({ ...admin, isAdmin: false }) as unknown as SupabaseAuthContext,
      {},
      AdminRequiredError,
      403,
    ],
    [
      "another request type",
      () => admin,
      { request_type: "access" },
      "pas une demande d'effacement",
      409,
    ],
    [
      "an unverified identity",
      () => admin,
      { identity_status: "authenticated" },
      "Vérifiez l'identité",
      409,
    ],
    ["a closed request", () => admin, { status: "completed" }, "déjà clôturée", 409],
    [
      "a wrong confirmation email",
      () => admin,
      { requester_email: "other@example.test" },
      "ne correspond pas",
      400,
    ],
  ])("refuses %s", async (_label, makeAuth, override, message, status) => {
    state.requestRow = request(override);
    await expect(executePrivacyErasure({ auth: makeAuth(), input })).rejects.toThrow(message);
    await expect(executePrivacyErasure({ auth: makeAuth(), input })).rejects.toMatchObject({
      status,
    });
    expect(state.deleteUser).not.toHaveBeenCalled();
    expect(state.stripeDel).not.toHaveBeenCalled();
  });

  it("never erases an administrator account", async () => {
    state.role = "admin";
    await expect(executePrivacyErasure({ auth: admin, input })).rejects.toThrow("administrateur");
    await expect(executePrivacyErasure({ auth: admin, input })).rejects.toMatchObject({
      status: 409,
    });
    expect(state.deleteUser).not.toHaveBeenCalled();
  });
});

describe("erasure: Stripe customers, guard, blocking references, retry and closure email", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state.requestRow = request();
    state.role = "user";
    state.customerId = "cus_sub";
    state.subscription = null;
    state.searchedCustomers = [];
    state.credits = { data: 0, error: null };
    state.blockingCounts = {};
    state.recentPurchases = [];
    state.deletes = [];
    state.deleteErrors = {};
    state.updates = [];
    state.metadataUpdates = [];
    state.order = [];
    state.stripeSearch.mockImplementation(async () => state.searchedCustomers);
    state.stripeDel.mockImplementation(async () => {
      state.order.push("stripe");
      return { deleted: true };
    });
    state.deleteUser.mockImplementation(async () => {
      state.order.push("auth-user");
      return { error: null };
    });
    state.storageList.mockResolvedValue({ data: [], error: null });
    state.storageRemove.mockResolvedValue({ error: null });
  });

  it("M1 : supprime chaque client Stripe du compte, celui de l'abonnement et ceux de la recherche, une fois chacun", async () => {
    state.searchedCustomers = [{ id: "cus_sub" }, { id: "cus_unit_purchase" }];
    const report = await executePrivacyErasure({ auth: admin, input });
    expect(state.stripeSearch).toHaveBeenCalledWith(expect.anything(), USER_ID);
    expect(state.stripeDel.mock.calls.map(([id]) => id).sort()).toEqual([
      "cus_sub",
      "cus_unit_purchase",
    ]);
    expect(report.stripeCustomerDeleted).toBe(true);
  });

  it("M2 : refuse sans confirmation quand un abonnement est actif, et l'exécute avec", async () => {
    state.subscription = {
      stripe_customer_id: "cus_sub",
      status: "active",
      current_period_end: "2099-01-01T00:00:00.000Z",
    };
    await expect(executePrivacyErasure({ auth: admin, input })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Abonnement Analyse actif"),
    });
    expect(state.stripeDel).not.toHaveBeenCalled();
    expect(state.deletes).toEqual([]);

    await executePrivacyErasure({ auth: admin, input: { ...input, confirmFinancialImpact: true } });
    expect(state.deleteUser).toHaveBeenCalledWith(USER_ID);
  });

  it("M2 : un achat rétractable ou un crédit non utilisé exigent aussi la confirmation", async () => {
    state.recentPurchases = [
      { id: "p1", paid_at: "2026-11-15T10:00:00.000Z", amount_cents: 1900, currency: "eur" },
    ];
    await expect(executePrivacyErasure({ auth: admin, input })).rejects.toThrow(
      "achat(s) à l'unité",
    );
    state.recentPurchases = [];
    state.credits = { data: 2, error: null };
    await expect(executePrivacyErasure({ auth: admin, input })).rejects.toThrow(
      "2 crédit(s) d'achat à l'unité",
    );
    expect(state.deleteUser).not.toHaveBeenCalled();
  });

  it("M2 : sans la fonction des crédits (migration en attente), la confirmation est exigée", async () => {
    state.credits = { data: null, error: { code: "PGRST202" } };
    await expect(executePrivacyErasure({ auth: admin, input })).rejects.toThrow("non vérifiables");
    await executePrivacyErasure({ auth: admin, input: { ...input, confirmFinancialImpact: true } });
    expect(state.deleteUser).toHaveBeenCalled();
  });

  it("F2 : un dossier de l'agent créé par le compte bloque l'effacement avant toute suppression", async () => {
    state.blockingCounts = { information_agent_cases: 2 };
    await expect(executePrivacyErasure({ auth: admin, input })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("2 dossier(s) de l'agent d'information"),
    });
    expect(state.stripeDel).not.toHaveBeenCalled();
    expect(state.deletes).toEqual([]);
    expect(state.metadataUpdates).toEqual([]);
    expect(state.deleteUser).not.toHaveBeenCalled();
  });

  it("M5 : efface les invitations reçues par le compte et celles envoyées à son adresse", async () => {
    await executePrivacyErasure({ auth: admin, input });
    expect(state.deletes).toContainEqual({
      table: "sale_workspace_collaborators",
      column: "collaborator_user_id",
      value: USER_ID,
    });
    expect(state.deletes).toContainEqual({
      table: "sale_workspace_collaborators",
      column: "invited_email",
      value: "client@example.test",
    });
  });

  it("F1 : compte déjà supprimé (relance), la demande est close au lieu d'échouer", async () => {
    const ACCOUNT = "33333333-3333-4333-8333-333333333333";
    state.requestRow = request({
      user_id: null,
      metadata: { source: "authenticated_rights_portal", erasure: { account_id: ACCOUNT } },
    });
    state.searchedCustomers = [{ id: "cus_left" }];
    const report = await executePrivacyErasure({ auth: admin, input });

    expect(state.deleteUser).not.toHaveBeenCalled();
    expect(state.stripeSearch).toHaveBeenCalledWith(expect.anything(), ACCOUNT);
    expect(state.stripeDel).toHaveBeenCalledWith("cus_left");
    // Les tables liées au compte sont parties en cascade : seules les suppressions par adresse restent.
    expect(state.deletes.map((entry) => entry.column).sort()).toEqual([
      "invited_email",
      "to_address",
    ]);
    expect(state.updates.at(-1)).toMatchObject({
      status: "completed",
      resolution_code: "erasure_executed",
    });
    expect(report.authUserDeleted).toBe(true);
  });

  it("F1 : sans trace du compte (demande antérieure), close aussi, sans appel à Stripe", async () => {
    state.requestRow = request({ user_id: null });
    await executePrivacyErasure({ auth: admin, input });
    expect(state.stripeSearch).not.toHaveBeenCalled();
    expect(state.updates.at(-1)).toMatchObject({ resolution_code: "erasure_executed" });
  });

  it("tolère un compte Auth déjà supprimé entre deux tentatives", async () => {
    state.deleteUser.mockResolvedValue({ error: { status: 404, message: "User not found" } });
    await expect(executePrivacyErasure({ auth: admin, input })).resolves.toMatchObject({
      authUserDeleted: true,
    });
  });

  it("E2 : pose l'email de clôture en attente puis l'envoie, vers l'adresse de la demande", async () => {
    await executePrivacyErasure({ auth: admin, input });
    expect(state.updates.at(-1)?.metadata).toMatchObject({
      notifications: {
        closure: { status: "pending", outcome: "completed", erasure_executed: true },
      },
    });
    expect(state.notifyClosed).toHaveBeenCalledTimes(1);
    expect(state.notifyClosed.mock.calls[0][0]).toMatchObject({
      id: REQUEST_ID,
      requester_email: "client@example.test",
    });
  });
});

describe("erasure deadline display and J-7 alert (P4-10)", () => {
  const now = new Date("2026-10-10T10:00:00.000Z");

  it("shows the remaining days before the one-month deadline", () => {
    const status = privacyDeadlineStatus("2026-10-30T10:00:00.000Z", "in_review", now);
    expect(status).toEqual({ daysRemaining: 20, overdue: false, dueSoon: false });
    expect(privacyDeadlineLabel(status)).toBe("20 jours restants");
  });

  it("raises the alert from J-7", () => {
    expect(privacyDeadlineStatus("2026-10-17T10:00:00.000Z", "received", now).dueSoon).toBe(true);
    expect(privacyDeadlineStatus("2026-10-18T10:00:00.000Z", "received", now).dueSoon).toBe(false);
  });

  it("flags overdue requests and ignores closed ones", () => {
    const late = privacyDeadlineStatus("2026-10-07T10:00:00.000Z", "in_review", now);
    expect(late).toMatchObject({ overdue: true, dueSoon: false, daysRemaining: -3 });
    expect(privacyDeadlineLabel(late)).toBe("En retard de 3 jours");
    expect(privacyDeadlineStatus("2026-10-07T10:00:00.000Z", "completed", now)).toEqual({
      daysRemaining: null,
      overdue: false,
      dueSoon: false,
    });
  });
});
