import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  oppose: vi.fn(),
  message: null as Record<string, unknown> | null,
  informationCase: null as Record<string, unknown> | null,
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.auth,
}));

vi.mock("@/lib/information-agent/contacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/information-agent/contacts")>()),
  recordInformationAgentContactOpposition: mocks.oppose,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  class Query {
    constructor(private readonly table: string) {}
    select() {
      return this;
    }
    eq() {
      return this;
    }
    update(values: Record<string, unknown>) {
      mocks.updates.push(values);
      return this;
    }
    async maybeSingle() {
      return {
        data: this.table === "information_agent_messages" ? mocks.message : mocks.informationCase,
        error: null,
      };
    }
    then(onFulfilled: (value: { error: null }) => unknown) {
      return Promise.resolve({ error: null }).then(onFulfilled);
    }
  }
  return { supabaseAdmin: { from: (table: string) => new Query(table) } };
});

import { runAdminInformationAgentMessageAction } from "@/lib/admin-information-agent";

const MESSAGE_ID = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updates.length = 0;
  mocks.auth.mockResolvedValue({ isAdmin: true, userId: "admin-1" });
  mocks.message = {
    id: MESSAGE_ID,
    case_id: "33333333-3333-4333-8333-333333333333",
    from_email: "Secretariat@Cabinet.test",
    metadata: { channel: "portal" },
  };
  mocks.informationCase = { normalized_recipient_email: "me.dupont@cabinet.test" };
});

describe("actions de l'administrateur sur une réponse reçue", () => {
  it("enregistre l'opposition du contact sollicité et de l'expéditeur, puis sort la réponse de la file", async () => {
    const result = await runAdminInformationAgentMessageAction({
      authToken: "token",
      input: { action: "record_opposition", messageId: MESSAGE_ID },
    });

    expect(result.opposedEmails).toEqual(["me.dupont@cabinet.test", "secretariat@cabinet.test"]);
    expect(mocks.oppose).toHaveBeenCalledTimes(2);
    expect(mocks.updates[0]?.metadata).toMatchObject({
      channel: "portal",
      admin_handled_by: "admin-1",
      admin_handled_action: "record_opposition",
    });
  });

  it("marque une réponse comme traitée sans rien opposer", async () => {
    await runAdminInformationAgentMessageAction({
      authToken: "token",
      input: { action: "mark_handled", messageId: MESSAGE_ID },
    });
    expect(mocks.oppose).not.toHaveBeenCalled();
    expect(mocks.updates[0]?.metadata).toMatchObject({ admin_handled_action: "mark_handled" });
  });

  it("refuse un non-administrateur et une réponse introuvable", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: false, userId: "user-1" });
    await expect(
      runAdminInformationAgentMessageAction({
        authToken: "token",
        input: { action: "mark_handled", messageId: MESSAGE_ID },
      }),
    ).rejects.toThrow("Forbidden");

    mocks.auth.mockResolvedValue({ isAdmin: true, userId: "admin-1" });
    mocks.message = null;
    await expect(
      runAdminInformationAgentMessageAction({
        authToken: "token",
        input: { action: "mark_handled", messageId: MESSAGE_ID },
      }),
    ).rejects.toThrow("Réponse introuvable.");
    expect(mocks.updates).toHaveLength(0);
  });
});
