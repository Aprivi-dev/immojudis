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
  deletes: [] as Array<{ table: string; column: string; value: string }>,
  updates: [] as Array<Record<string, unknown>>,
  order: [] as string[],
  deleteUser: vi.fn(),
  stripeDel: vi.fn(),
  storageList: vi.fn(),
  storageRemove: vi.fn(),
}));

vi.mock("@/lib/billing", () => ({ getStripe: () => ({ customers: { del: state.stripeDel } }) }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    auth: { admin: { deleteUser: state.deleteUser } },
    storage: { from: () => ({ list: state.storageList, remove: state.storageRemove }) },
    from(table: string) {
      let mode: "select" | "delete" | "update" = "select";
      let payload: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {
        select: () => builder,
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
          if (mode === "delete") {
            state.deletes.push({ table, column, value });
            state.order.push(`delete:${table}`);
            return Promise.resolve({ count: 1, error: null });
          }
          return builder;
        },
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
              data: state.customerId ? { stripe_customer_id: state.customerId } : null,
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
    ...overrides,
  };
}

describe("erasure execution (P4-10)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state.requestRow = request();
    state.role = "user";
    state.customerId = "cus_123";
    state.deletes = [];
    state.updates = [];
    state.order = [];
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
    expect(state.order[0]).toBe("stripe");
    expect(state.order.at(-2)).toBe("auth-user");
    expect(state.order.at(-1)).toBe("close-request");
    expect(state.deleteUser).toHaveBeenCalledWith(USER_ID);
    const tables = state.deletes.map((entry) => entry.table);
    for (const table of [
      "user_alerts",
      "user_favorites",
      "saved_property_reports",
      "sale_workspaces",
      "user_subscriptions",
    ]) {
      expect(tables).toContain(table);
    }
    expect(state.deletes.every((entry) => entry.value === USER_ID)).toBe(true);
    expect(state.updates[0]).toMatchObject({
      status: "completed",
      resolution_code: "erasure_executed",
    });
    expect(report).toMatchObject({ stripeCustomerDeleted: true, authUserDeleted: true });
    expect(report.request.status).toBe("completed");
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
      "Forbidden",
    ],
    [
      "another request type",
      () => admin,
      { request_type: "access" },
      "pas une demande d'effacement",
    ],
    [
      "an unverified identity",
      () => admin,
      { identity_status: "authenticated" },
      "Vérifiez l'identité",
    ],
    ["a closed request", () => admin, { status: "completed" }, "déjà clôturée"],
    ["an already deleted account", () => admin, { user_id: null }, "n'existe plus"],
    [
      "a wrong confirmation email",
      () => admin,
      { requester_email: "other@example.test" },
      "ne correspond pas",
    ],
  ])("refuses %s", async (_label, makeAuth, override, message) => {
    state.requestRow = request(override);
    await expect(executePrivacyErasure({ auth: makeAuth(), input })).rejects.toThrow(message);
    expect(state.deleteUser).not.toHaveBeenCalled();
    expect(state.stripeDel).not.toHaveBeenCalled();
  });

  it("never erases an administrator account", async () => {
    state.role = "admin";
    await expect(executePrivacyErasure({ auth: admin, input })).rejects.toThrow("administrateur");
    expect(state.deleteUser).not.toHaveBeenCalled();
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
