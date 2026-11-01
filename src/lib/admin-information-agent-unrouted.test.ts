import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  tables: [] as string[],
  calls: [] as Array<[string, ...unknown[]]>,
  existing: null as Record<string, unknown> | null,
  list: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.auth,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  class Query {
    constructor(table: string) {
      mocks.tables.push(table);
    }
    select(...args: unknown[]) {
      mocks.calls.push(["select", ...args]);
      return this;
    }
    eq(...args: unknown[]) {
      mocks.calls.push(["eq", ...args]);
      return this;
    }
    order(...args: unknown[]) {
      mocks.calls.push(["order", ...args]);
      return this;
    }
    range(...args: unknown[]) {
      mocks.calls.push(["range", ...args]);
      return this;
    }
    update(values: Record<string, unknown>) {
      mocks.calls.push(["update", values]);
      return this;
    }
    async maybeSingle() {
      return { data: mocks.existing, error: null };
    }
    then(onFulfilled: (value: unknown) => unknown) {
      return Promise.resolve({
        data: mocks.list,
        count: 130,
        error: null,
      }).then(onFulfilled);
    }
  }
  return { supabaseAdmin: { from: (table: string) => new Query(table) } };
});

import {
  adminInformationAgentUnroutedActionSchema,
  listAdminInformationAgentUnrouted,
  runAdminInformationAgentUnroutedAction,
} from "@/lib/admin-information-agent";

const MESSAGE_ID = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tables.length = 0;
  mocks.calls.length = 0;
  mocks.list = [{ id: MESSAGE_ID }];
  mocks.existing = { id: MESSAGE_ID };
  mocks.auth.mockResolvedValue({ isAdmin: true, userId: "admin-1" });
});

describe("messages non rattachés côté administrateur", () => {
  it("liste les messages à traiter, du plus récent au plus ancien, par pages", async () => {
    const page = await listAdminInformationAgentUnrouted("token", { offset: 50, limit: 50 });

    expect(page).toMatchObject({ messages: [{ id: MESSAGE_ID }], total: 130, offset: 50 });
    expect(page.hasMore).toBe(true);
    expect(mocks.tables).toEqual(["information_agent_unrouted_messages"]);
    expect(mocks.calls).toContainEqual(["eq", "status", "pending"]);
    expect(mocks.calls).toContainEqual(["order", "received_at", { ascending: false }]);
    expect(mocks.calls).toContainEqual(["range", 50, 99]);
  });

  it("refuse la liste et l'action à un compte qui n'est pas administrateur", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: false, userId: "user-1" });

    await expect(listAdminInformationAgentUnrouted("token")).rejects.toThrow("Forbidden");
    await expect(
      runAdminInformationAgentUnroutedAction({
        authToken: "token",
        input: { action: "mark_handled", messageId: MESSAGE_ID },
      }),
    ).rejects.toThrow("Forbidden");
    expect(mocks.tables).toEqual([]);
  });

  it("marque un message comme traité, avec la date et l'administrateur, sans rien d'autre", async () => {
    const result = await runAdminInformationAgentUnroutedAction({
      authToken: "token",
      input: { action: "mark_handled", messageId: MESSAGE_ID },
    });

    expect(result).toEqual({ ok: true });
    // Une seule table touchée : ni dossier, ni message de dossier, ni fait extrait, ni registre d'opposition.
    expect(new Set(mocks.tables)).toEqual(new Set(["information_agent_unrouted_messages"]));
    const update = mocks.calls.find(([name]) => name === "update");
    expect(update?.[1]).toEqual({
      status: "handled",
      handled_at: expect.any(String),
      handled_by: "admin-1",
    });
    expect(mocks.calls).toContainEqual(["eq", "status", "pending"]);
  });

  it("signale un message introuvable", async () => {
    mocks.existing = null;

    await expect(
      runAdminInformationAgentUnroutedAction({
        authToken: "token",
        input: { action: "mark_handled", messageId: MESSAGE_ID },
      }),
    ).rejects.toThrow("Message introuvable.");
    expect(mocks.calls.some(([name]) => name === "update")).toBe(false);
  });

  it("n'accepte que l'action « mark_handled » sur un identifiant valide", () => {
    expect(
      adminInformationAgentUnroutedActionSchema.safeParse({
        action: "record_opposition",
        messageId: MESSAGE_ID,
      }).success,
    ).toBe(false);
    expect(
      adminInformationAgentUnroutedActionSchema.safeParse({
        action: "mark_handled",
        messageId: "pas-un-guid",
      }).success,
    ).toBe(false);
  });
});
