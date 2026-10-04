import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAdminInformationAgentAction } from "@/lib/information-agent";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  persistFactCandidates: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: mocks.from,
    rpc: vi.fn(),
  },
}));

vi.mock("@/lib/information-agent-inbound", async () => {
  const actual = await vi.importActual<typeof import("@/lib/information-agent-inbound")>(
    "@/lib/information-agent-inbound",
  );
  return { ...actual, persistFactCandidates: mocks.persistFactCandidates };
});

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MISSION_ID = "11111111-1111-4111-8111-111111111111";
const CASE_ID = "22222222-2222-4222-8222-222222222222";
const SALE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_MISSION_ID = "55555555-5555-4555-8555-555555555555";
const CREATED_AT = "2026-09-28T10:00:00.000Z";

type Row = Record<string, unknown>;

class Query implements PromiseLike<{ data: Row[] | null; error: Row | null }> {
  private operation: "select" | "insert" | "update" = "select";
  private values: Row | null = null;
  private conditions: Array<(row: Row) => boolean> = [];

  constructor(
    private readonly table: string,
    private readonly tables: Record<string, Row[]>,
    private readonly beforeUpdate?: (table: string) => void,
  ) {}

  select() {
    return this;
  }

  eq(key: string, value: unknown) {
    this.conditions.push((row) => row[key] === value);
    return this;
  }

  in(key: string, values: unknown[]) {
    this.conditions.push((row) => values.includes(row[key]));
    return this;
  }

  order() {
    return this;
  }

  limit() {
    return this;
  }

  insert(values: Row) {
    this.operation = "insert";
    this.values = values;
    return this;
  }

  update(values: Row) {
    this.operation = "update";
    this.values = values;
    return this;
  }

  async single() {
    const result = this.execute();
    return { data: result.data[0] ?? null, error: result.error };
  }

  async maybeSingle() {
    const result = this.execute();
    return { data: result.data[0] ?? null, error: result.error };
  }

  then<TResult1 = { data: Row[] | null; error: Row | null }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: Row[] | null; error: Row | null }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private execute(): { data: Row[]; error: Row | null } {
    const rows = this.tables[this.table];
    if (!rows) throw new Error(`Unexpected table ${this.table}`);

    if (this.operation === "insert") {
      const value = { ...(this.values ?? {}) };
      if (this.table === "information_agent_messages" && !value.id) {
        value.id = "66666666-6666-4666-8666-666666666666";
      }
      if (
        this.table === "information_agent_messages" &&
        rows.some((row) => row.provider_message_id === value.provider_message_id)
      ) {
        return { data: [], error: { code: "23505", message: "duplicate provider id" } };
      }
      rows.push(value);
      return { data: [value], error: null };
    }

    if (this.operation === "update") this.beforeUpdate?.(this.table);
    const selected = rows.filter((row) => this.conditions.every((condition) => condition(row)));
    if (this.operation === "update") {
      selected.forEach((row) => Object.assign(row, this.values));
    }
    return { data: selected, error: null };
  }
}

function fixture({ moveCaseToReviewBeforeReplyUpdate = false } = {}) {
  const mission: Row = {
    id: MISSION_ID,
    user_id: ADMIN_ID,
    sale_id: SALE_ID,
    case_id: CASE_ID,
    status: "sent",
    recipient_kind: "source_contact",
    recipient_name: "Étude Test",
    recipient_email: "contact@example.test",
    reply_to_email: "replies@example.test",
    subject: "Demande de pièces",
    body_text: "Bonjour, merci de transmettre les éléments du dossier.",
    question_keys: ["documents"],
    missing_information: ["documents"],
    failure_reason: null,
    approved_at: "2026-09-28T09:00:00.000Z",
    sent_at: "2026-09-28T09:01:00.000Z",
    replied_at: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
  const sharedCase: Row = {
    id: CASE_ID,
    sale_id: SALE_ID,
    created_by: ADMIN_ID,
    status: "sent",
    recipient_kind: "source_contact",
    recipient_name: "Étude Test",
    recipient_email: "contact@example.test",
    normalized_recipient_email: "contact@example.test",
    subject: "Demande de pièces",
    body_text: "Bonjour, merci de transmettre les éléments du dossier.",
    question_keys: ["documents"],
    missing_information: ["documents"],
    inbound_token: "44444444-4444-4444-8444-444444444444",
    initiator_mission_id: MISSION_ID,
    provider_message_id: "provider-initial",
    failure_reason: null,
    metadata: {},
    sent_at: "2026-09-28T09:01:00.000Z",
    replied_at: null,
    completed_at: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
  const otherMission: Row = {
    id: OTHER_MISSION_ID,
    user_id: ADMIN_ID,
    sale_id: SALE_ID,
    case_id: CASE_ID,
    status: "subscribed",
    recipient_kind: "source_contact",
    recipient_name: "Étude Test",
    recipient_email: "contact@example.test",
    reply_to_email: "replies@example.test",
    subject: "Demande de pièces",
    body_text: "Bonjour, merci de transmettre les éléments du dossier.",
    question_keys: ["documents"],
    missing_information: ["documents"],
    failure_reason: null,
    approved_at: null,
    sent_at: null,
    replied_at: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
  const tables: Record<string, Row[]> = {
    information_agent_missions: [mission, otherMission],
    information_agent_cases: [sharedCase],
    information_agent_case_subscribers: [
      { case_id: CASE_ID, mission_id: OTHER_MISSION_ID, user_id: ADMIN_ID },
    ],
    information_agent_messages: [],
    information_agent_fact_candidates: [],
  };
  let moveCaseToReview = moveCaseToReviewBeforeReplyUpdate;
  mocks.from.mockImplementation(
    (table: string) =>
      new Query(table, tables, (updatedTable) => {
        if (updatedTable === "information_agent_cases" && moveCaseToReview) {
          moveCaseToReview = false;
          sharedCase.status = "review";
        }
      }),
  );
  mocks.persistFactCandidates.mockResolvedValue(undefined);
  return {
    mission,
    otherMission,
    sharedCase,
    messages: tables.information_agent_messages,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("manual information agent replies", () => {
  it("extracts facts as review candidates and stays idempotent on retry", async () => {
    const state = fixture();
    const input = {
      action: "record_reply" as const,
      missionId: MISSION_ID,
      subject: "Re: Demande de pièces",
      bodyText: "Le bien est libre, sa surface est de 84 m² et il comprend 4 pièces.",
    };

    await runAdminInformationAgentAction({
      auth: { isAdmin: true, userId: ADMIN_ID } as never,
      input,
    });
    await runAdminInformationAgentAction({
      auth: { isAdmin: true, userId: ADMIN_ID } as never,
      input,
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      case_id: CASE_ID,
      mission_id: MISSION_ID,
      direction: "inbound",
      message_kind: "reply",
      delivery_status: "received",
      metadata: {
        imported_manually: true,
        content_trust: "untrusted",
        channel: "admin_manual_reply",
      },
    });
    expect(mocks.persistFactCandidates).toHaveBeenCalledTimes(2);
    expect(mocks.persistFactCandidates).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sharedCase: expect.objectContaining({ id: CASE_ID, sale_id: SALE_ID }),
        messageId: state.messages[0]?.id,
        assets: [],
        facts: expect.arrayContaining([
          expect.objectContaining({ factKey: "surface_m2" }),
          expect.objectContaining({ factKey: "rooms_count" }),
          expect.objectContaining({ factKey: "occupancy_status" }),
        ]),
      }),
    );
    expect(state.sharedCase.status).toBe("review");
    expect(state.mission.status).toBe("replied");
    expect(state.otherMission.status).toBe("replied");
  });

  it("keeps a case in review when a later manual reply has no extractable fact", async () => {
    const state = fixture();

    await runAdminInformationAgentAction({
      auth: { isAdmin: true, userId: ADMIN_ID } as never,
      input: {
        action: "record_reply",
        missionId: MISSION_ID,
        bodyText: "Le bien est libre et sa surface est de 84 m².",
      },
    });
    await runAdminInformationAgentAction({
      auth: { isAdmin: true, userId: ADMIN_ID } as never,
      input: {
        action: "record_reply",
        missionId: MISSION_ID,
        bodyText: "Merci pour votre retour, nous allons vérifier le dossier.",
      },
    });

    expect(state.sharedCase.status).toBe("review");
    expect(state.mission.status).toBe("replied");
    expect(state.messages).toHaveLength(2);
  });

  it("preserves review when the case changes after the manual reply snapshot", async () => {
    const state = fixture({ moveCaseToReviewBeforeReplyUpdate: true });

    await runAdminInformationAgentAction({
      auth: { isAdmin: true, userId: ADMIN_ID } as never,
      input: {
        action: "record_reply",
        missionId: MISSION_ID,
        bodyText: "Merci pour votre retour, nous vérifions le dossier.",
      },
    });

    expect(state.sharedCase.status).toBe("review");
    expect(state.mission.status).toBe("replied");
  });

  it("refuses a mission whose case belongs to another sale before writing a message", async () => {
    const state = fixture();
    state.sharedCase.sale_id = "55555555-5555-4555-8555-555555555555";

    await expect(
      runAdminInformationAgentAction({
        auth: { isAdmin: true, userId: ADMIN_ID } as never,
        input: {
          action: "record_reply",
          missionId: MISSION_ID,
          bodyText: "La réponse est reçue et doit être vérifiée par l'équipe.",
        },
      }),
    ).rejects.toThrow("dossier de vente introuvable ou incohérent");
    expect(state.messages).toHaveLength(0);
    expect(mocks.persistFactCandidates).not.toHaveBeenCalled();
  });

  it("rejects a reply after the case is closed", async () => {
    const state = fixture();
    state.sharedCase.status = "completed";

    await expect(
      runAdminInformationAgentAction({
        auth: { isAdmin: true, userId: ADMIN_ID } as never,
        input: {
          action: "record_reply",
          missionId: MISSION_ID,
          bodyText: "La réponse est reçue et doit être vérifiée par l'équipe.",
        },
      }),
    ).rejects.toThrow("dossier de cette enquête est déjà fermé");
    expect(state.messages).toHaveLength(0);
    expect(mocks.persistFactCandidates).not.toHaveBeenCalled();
  });
});
