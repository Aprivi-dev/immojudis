import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  informationAgentContributionUrl,
  loadInformationAgentContribution,
  prepareInformationAgentContributionUpload,
  submitInformationAgentContribution,
} from "@/lib/information-agent-contribution";
import { createInformationAgentContributionToken } from "@/lib/information-agent-contribution-token";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  storageFrom: vi.fn(),
  rpc: vi.fn(),
  enforceRateLimit: vi.fn(),
  persistFactCandidates: vi.fn(),
  resolveSiteOrigin: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: mocks.from,
    rpc: mocks.rpc,
    storage: { from: mocks.storageFrom },
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceUserRateLimit: mocks.enforceRateLimit,
}));

vi.mock("@/lib/site-url", () => ({
  resolveSiteOrigin: mocks.resolveSiteOrigin,
}));

vi.mock("@/lib/information-agent-inbound", async () => {
  const actual = await vi.importActual<typeof import("@/lib/information-agent-inbound")>(
    "@/lib/information-agent-inbound",
  );
  return { ...actual, persistFactCandidates: mocks.persistFactCandidates };
});

const MISSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_MISSION_ID = "22222222-2222-4222-8222-222222222222";
const CASE_ID = "33333333-3333-4333-8333-333333333333";
const RETRIED_CASE_ID = "77777777-7777-4777-8777-777777777777";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const CREATED_AT = new Date(Date.now() - 60_000).toISOString();
const SECRET = "portal-secret-that-is-at-least-32-characters-long";
const RECIPIENT_A = "contact@example.test";
const RECIPIENT_B = "new-contact@example.test";
const ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  INFORMATION_AGENT_PORTAL_SECRET: SECRET,
};
const TOKEN = createInformationAgentContributionToken(
  MISSION_ID,
  CREATED_AT,
  CASE_ID,
  RECIPIENT_A,
  1,
  SECRET,
);
const OTHER_TOKEN = createInformationAgentContributionToken(
  OTHER_MISSION_ID,
  CREATED_AT,
  CASE_ID,
  RECIPIENT_A,
  1,
  SECRET,
);

type Row = Record<string, unknown>;

class Query implements PromiseLike<{ data: Row[] | null; error: Row | null }> {
  private conditions: Array<(row: Row) => boolean> = [];
  private operation: "select" | "insert" | "update" = "select";
  private values: Row | Row[] | null = null;

  constructor(
    private readonly table: string,
    private readonly tables: Record<string, Row[]>,
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

  lt(key: string, value: string) {
    this.conditions.push((row) => String(row[key]) < value);
    return this;
  }

  limit() {
    return this;
  }

  insert(values: Row | Row[]) {
    this.operation = "insert";
    this.values = values;
    return this;
  }

  update(values: Row) {
    this.operation = "update";
    this.values = values;
    return this;
  }

  upsert(values: Row) {
    this.operation = "insert";
    this.values = values;
    return this;
  }

  async maybeSingle() {
    const result = this.execute();
    return { data: result.data[0] ?? null, error: result.error };
  }

  async single() {
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
    if (!rows) throw new Error(`Unexpected table: ${this.table}`);

    if (this.operation === "insert") {
      const incoming = Array.isArray(this.values) ? this.values : [this.values as Row];
      if (
        this.table === "information_agent_messages" &&
        incoming.some((row) =>
          rows.some((existing) => existing.provider_message_id === row.provider_message_id),
        )
      ) {
        return { data: [], error: { code: "23505", message: "duplicate provider message" } };
      }
      if (
        this.table === "information_agent_evidence_assets" &&
        incoming.some((row) => rows.some((existing) => existing.storage_path === row.storage_path))
      ) {
        return { data: [], error: { code: "23505", message: "duplicate storage path" } };
      }
      const inserted = incoming.map((row) => ({ ...row }));
      rows.push(...inserted);
      return { data: inserted, error: null };
    }

    const selected = rows.filter((row) => this.conditions.every((condition) => condition(row)));
    if (this.operation === "update") {
      selected.forEach((row) => Object.assign(row, this.values));
    }
    return { data: selected, error: null };
  }
}

function fixture() {
  const mission: Row = {
    id: MISSION_ID,
    case_id: CASE_ID,
    user_id: USER_ID,
    status: "sent",
    created_at: CREATED_AT,
    contribution_token_version: 1,
    recipient_email: RECIPIENT_A,
  };
  const informationCase: Row = {
    id: CASE_ID,
    sale_id: "55555555-5555-4555-8555-555555555555",
    created_by: USER_ID,
    status: "sent",
    recipient_email: RECIPIENT_A,
    normalized_recipient_email: RECIPIENT_A,
    subject: "Vente à Bordeaux",
    initiator_mission_id: MISSION_ID,
  };
  const tables: Record<string, Row[]> = {
    information_agent_missions: [mission],
    information_agent_cases: [informationCase],
    information_agent_messages: [],
    information_agent_evidence_assets: [],
    information_agent_contacts: [],
    information_agent_portal_upload_reservations: [],
  };
  const storage = {
    remove: vi.fn(async () => ({ data: [], error: null })),
    createSignedUploadUrl: vi.fn(async () => ({
      data: { token: "signed-upload-token" },
      error: null,
    })),
    download: vi.fn(),
  };
  mocks.from.mockImplementation((table: string) => new Query(table, tables));
  mocks.storageFrom.mockReturnValue(storage);
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === "reserve_information_agent_portal_upload") {
      return {
        data: [
          {
            used_bytes: 41943040,
            used_files: 1,
            remaining_bytes: 461373440,
            remaining_files: 11,
          },
        ],
        error: null,
      };
    }
    if (name === "consume_information_agent_portal_upload") {
      return { data: null, error: null };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  });
  mocks.enforceRateLimit.mockResolvedValue(undefined);
  mocks.persistFactCandidates.mockResolvedValue(undefined);
  return {
    mission,
    informationCase,
    messages: tables.information_agent_messages,
    assets: tables.information_agent_evidence_assets,
    cases: tables.information_agent_cases,
    contacts: tables.information_agent_contacts,
    reservations: tables.information_agent_portal_upload_reservations,
    storage,
  };
}

const pdfBytes = (surface: string) => new TextEncoder().encode(`%PDF-1.7\n${surface}`);

async function preparedFile(
  state: ReturnType<typeof fixture>,
  overrides: Partial<{
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
  }> = {},
) {
  const bytes = overrides.bytes ?? pdfBytes("fixture");
  const filename = overrides.filename ?? "cahier.pdf";
  const mimeType = overrides.mimeType ?? "application/pdf";
  const prepared = await prepareInformationAgentContributionUpload({
    missionId: MISSION_ID,
    input: { token: TOKEN, filename, mimeType, size: bytes.length },
    env: ENV,
  });
  const blobBytes = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(blobBytes).set(bytes);
  state.storage.download.mockResolvedValue({
    data: new Blob([blobBytes], { type: mimeType }),
    error: null,
  });
  return { ...prepared, filename, mimeType, size: bytes.length };
}

function submission(
  file: Awaited<ReturnType<typeof preparedFile>>,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    token: TOKEN,
    submissionId: "66666666-6666-4666-8666-666666666666",
    senderName: "Étude Dupont",
    senderEmail: "contact@example.test",
    note: "La surface habitable est de 84 m² et le bien comprend 4 pièces.",
    externalLinks: [],
    authorizedToTransmit: true as const,
    files: [
      {
        path: file.path,
        filename: file.filename,
        mimeType: file.mimeType,
        size: file.size,
        ticket: file.ticket,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveSiteOrigin.mockReturnValue("https://immojudis.example");
});

describe("information agent contribution integration", () => {
  it("refuses to create a bearer link over HTTP", () => {
    mocks.resolveSiteOrigin.mockReturnValue("http://immojudis.example");

    expect(() =>
      informationAgentContributionUrl(
        {
          id: MISSION_ID,
          created_at: CREATED_AT,
          case_id: CASE_ID,
          recipient_email: RECIPIENT_A,
          contribution_token_version: 1,
        },
        ENV,
      ),
    ).toThrow("HTTPS");
  });

  it("accepts a valid contribution, stores the file and sends extracted facts to candidates", async () => {
    const state = fixture();
    const file = await preparedFile(state);

    const result = await submitInformationAgentContribution({
      missionId: MISSION_ID,
      input: submission(file),
      env: ENV,
    });

    expect(result).toMatchObject({ assetCount: 1, senderMatches: true });
    expect(state.messages).toHaveLength(1);
    expect(state.assets).toHaveLength(1);
    expect(state.assets[0]).toMatchObject({
      case_id: CASE_ID,
      storage_path: file.path,
      mime_type: "application/pdf",
      rights_status: "unverified",
    });
    expect(mocks.persistFactCandidates).toHaveBeenCalledTimes(1);
    expect(mocks.persistFactCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: result.messageId }),
    );
    const persisted = mocks.persistFactCandidates.mock.calls[0]?.[0];
    expect(persisted.facts.map((fact: { factKey: string }) => fact.factKey)).toEqual([
      "surface_m2",
      "rooms_count",
    ]);
    expect(persisted.assets).toHaveLength(1);
    expect(state.informationCase.status).toBe("review");
    expect(state.mission.status).toBe("replied");
  });

  it("records an opposition when the portal note asks to stop contact", async () => {
    const state = fixture();
    const file = await preparedFile(state);
    await submitInformationAgentContribution({
      missionId: MISSION_ID,
      input: submission(file, { files: [], note: "Merci de ne plus me contacter." }),
      env: ENV,
    });

    expect(state.contacts).toEqual([
      expect.objectContaining({
        email: RECIPIENT_A,
        scope_sale_id: null,
        opposition_status: "opposed",
      }),
    ]);
    // La note reste rattachée au dossier, avec sa provenance « portail ».
    expect(state.messages[0]).toMatchObject({
      case_id: CASE_ID,
      metadata: expect.objectContaining({ channel: "portal", content_trust: "untrusted" }),
    });
  });

  it("stops a signed upload when the database quota is exhausted", async () => {
    const state = fixture();
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "reserve_information_agent_portal_upload") {
        return {
          data: null,
          error: { code: "54000", message: "INFORMATION_AGENT_PORTAL_QUOTA_EXCEEDED" },
        };
      }
      return { data: null, error: null };
    });

    await expect(
      prepareInformationAgentContributionUpload({
        missionId: MISSION_ID,
        input: {
          token: TOKEN,
          filename: "cahier.pdf",
          mimeType: "application/pdf",
          size: 1024,
        },
        env: ENV,
      }),
    ).rejects.toMatchObject({
      status: 413,
      message: expect.stringContaining("La capacité de dépôt de ce dossier est atteinte"),
    });
    expect(state.storage.createSignedUploadUrl).toHaveBeenCalledTimes(1);
  });

  it("rend la capacité des envois abandonnés, objet orphelin supprimé d'abord", async () => {
    const state = fixture();
    const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    state.reservations.push(
      {
        id: "r1",
        case_id: CASE_ID,
        storage_path: `${CASE_ID}/portal/a/x.pdf`,
        status: "reserved",
        expires_at: longAgo,
      },
      {
        id: "r2",
        case_id: CASE_ID,
        storage_path: `${CASE_ID}/portal/b/y.pdf`,
        status: "reserved",
        expires_at: soon,
      },
      {
        id: "r3",
        case_id: CASE_ID,
        storage_path: `${CASE_ID}/portal/c/z.pdf`,
        status: "consumed",
        expires_at: longAgo,
      },
    );

    await prepareInformationAgentContributionUpload({
      missionId: MISSION_ID,
      input: { token: TOKEN, filename: "cahier.pdf", mimeType: "application/pdf", size: 1024 },
      env: ENV,
    });

    expect(state.storage.remove).toHaveBeenCalledWith([`${CASE_ID}/portal/a/x.pdf`]);
    expect(state.reservations.map((row) => row.status)).toEqual([
      "released",
      "reserved",
      "consumed",
    ]);
  });

  it("garde la réservation comptée si l'objet orphelin n'a pas pu être supprimé", async () => {
    const state = fixture();
    state.reservations.push({
      id: "r1",
      case_id: CASE_ID,
      storage_path: `${CASE_ID}/portal/a/x.pdf`,
      status: "reserved",
      expires_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });
    state.storage.remove.mockResolvedValueOnce({ data: null, error: { message: "down" } } as never);

    await prepareInformationAgentContributionUpload({
      missionId: MISSION_ID,
      input: { token: TOKEN, filename: "cahier.pdf", mimeType: "application/pdf", size: 1024 },
      env: ENV,
    });
    expect(state.reservations[0]?.status).toBe("reserved");
  });

  it("does not reserve capacity when Storage cannot issue a signed URL", async () => {
    const state = fixture();
    state.storage.createSignedUploadUrl.mockRejectedValueOnce(new Error("Storage unavailable"));

    await expect(
      prepareInformationAgentContributionUpload({
        missionId: MISSION_ID,
        input: {
          token: TOKEN,
          filename: "cahier.pdf",
          mimeType: "application/pdf",
          size: 1024,
        },
        env: ENV,
      }),
    ).rejects.toMatchObject({ message: "Storage unavailable" });
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "reserve_information_agent_portal_upload",
      expect.anything(),
    );
  });

  it("does not persist a message when the upload reservation has expired", async () => {
    const state = fixture();
    const file = await preparedFile(state);
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "reserve_information_agent_portal_upload") {
        return {
          data: [
            {
              used_bytes: 41943040,
              used_files: 1,
              remaining_bytes: 461373440,
              remaining_files: 11,
            },
          ],
          error: null,
        };
      }
      return {
        data: null,
        error: {
          code: "22023",
          message: "Information-agent portal upload reservation expired.",
        },
      };
    });

    await expect(
      submitInformationAgentContribution({
        missionId: MISSION_ID,
        input: submission(file),
        env: ENV,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(state.messages).toHaveLength(0);
    expect(state.assets).toHaveLength(0);
  });

  it("keeps the contribution when the case closes before the review update", async () => {
    const state = fixture();
    const file = await preparedFile(state);
    mocks.persistFactCandidates.mockImplementation(async () => {
      state.informationCase.status = "completed";
    });

    await expect(
      submitInformationAgentContribution({
        missionId: MISSION_ID,
        input: submission(file),
        env: ENV,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(state.messages).toHaveLength(1);
    expect(state.assets).toHaveLength(1);
    expect(state.informationCase.status).toBe("completed");
    expect(state.mission.status).toBe("sent");
  });

  it("rejects a token issued for a different mission and does not load the case", async () => {
    const state = fixture();

    await expect(
      loadInformationAgentContribution(MISSION_ID, OTHER_TOKEN, ENV),
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledWith("information_agent_missions");
    expect(state.informationCase.status).toBe("sent");
  });

  it("rejects the old link when a failed mission is retried for another recipient and case", async () => {
    const state = fixture();
    state.cases.push({
      ...state.informationCase,
      id: RETRIED_CASE_ID,
      recipient_email: RECIPIENT_B,
      normalized_recipient_email: RECIPIENT_B,
    });
    state.mission.case_id = RETRIED_CASE_ID;
    state.mission.recipient_email = RECIPIENT_B;
    state.mission.contribution_token_version = 2;

    await expect(loadInformationAgentContribution(MISSION_ID, TOKEN, ENV)).rejects.toMatchObject({
      status: 404,
    });

    const retriedToken = createInformationAgentContributionToken(
      MISSION_ID,
      CREATED_AT,
      RETRIED_CASE_ID,
      RECIPIENT_B,
      2,
      SECRET,
    );
    await expect(
      loadInformationAgentContribution(MISSION_ID, retriedToken, ENV),
    ).resolves.toMatchObject({ informationCase: { id: RETRIED_CASE_ID } });
  });

  it("rejects a link when the current case recipient no longer matches the mission", async () => {
    const state = fixture();
    state.informationCase.recipient_email = RECIPIENT_B;
    state.informationCase.normalized_recipient_email = RECIPIENT_B;

    await expect(loadInformationAgentContribution(MISSION_ID, TOKEN, ENV)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("rejects a file outside the case portal folder", async () => {
    const state = fixture();
    const file = await preparedFile(state);

    await expect(
      submitInformationAgentContribution({
        missionId: MISSION_ID,
        input: submission(file, {
          files: [
            {
              ...submission(file).files[0],
              path: `${OTHER_MISSION_ID}/portal/foreign.pdf`,
            },
          ],
        }),
        env: ENV,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(state.storage.download).not.toHaveBeenCalled();
    expect(state.messages).toHaveLength(0);
  });

  it("rejects an altered upload ticket before downloading the file", async () => {
    const state = fixture();
    const file = await preparedFile(state);
    const alteredTicket = `${file.ticket.slice(0, -1)}${file.ticket.endsWith("0") ? "1" : "0"}`;

    await expect(
      submitInformationAgentContribution({
        missionId: MISSION_ID,
        input: submission(file, {
          files: [{ ...submission(file).files[0], ticket: alteredTicket }],
        }),
        env: ENV,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(state.storage.download).not.toHaveBeenCalled();
    expect(state.messages).toHaveLength(0);
  });

  it("rejects a file whose bytes do not match the ticket MIME type", async () => {
    const state = fixture();
    const file = await preparedFile(state);
    state.storage.download.mockResolvedValue({
      data: new Blob(["this is not a PDF"]),
      error: null,
    });

    await expect(
      submitInformationAgentContribution({
        missionId: MISSION_ID,
        input: submission(file),
        env: ENV,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(state.messages).toHaveLength(0);
  });

  it("reuses the same message and asset for an identical submission", async () => {
    const state = fixture();
    const file = await preparedFile(state);
    const input = submission(file);

    const first = await submitInformationAgentContribution({
      missionId: MISSION_ID,
      input,
      env: ENV,
    });
    const second = await submitInformationAgentContribution({
      missionId: MISSION_ID,
      input,
      env: ENV,
    });

    expect(second.messageId).toBe(first.messageId);
    expect(second.assetCount).toBe(1);
    expect(state.messages).toHaveLength(1);
    expect(state.assets).toHaveLength(1);
    expect(mocks.persistFactCandidates).toHaveBeenCalledTimes(2);
  });

  it("reprend un dépôt interrompu avec une réponse corrigée, sans conflit sur la pièce déjà enregistrée", async () => {
    const state = fixture();
    const file = await preparedFile(state);
    // Premier essai : message et pièce enregistrés, puis une panne avant la fin.
    mocks.persistFactCandidates.mockRejectedValueOnce(new Error("panne passagère"));
    await expect(
      submitInformationAgentContribution({
        missionId: MISSION_ID,
        input: submission(file),
        env: ENV,
      }),
    ).rejects.toThrow("panne passagère");
    expect(state.messages).toHaveLength(1);
    expect(state.assets).toHaveLength(1);

    // Le formulaire change d'identifiant dès que la réponse est corrigée : autre message, même pièce.
    const retried = await submitInformationAgentContribution({
      missionId: MISSION_ID,
      input: submission(file, {
        submissionId: "88888888-8888-4888-8888-888888888888",
        note: "La surface habitable est de 84 m², corrigée.",
      }),
      env: ENV,
    });

    expect(retried.assetCount).toBe(1);
    expect(state.messages).toHaveLength(2);
    expect(state.assets).toHaveLength(1);
    expect(state.informationCase.status).toBe("review");
  });

  it("refuse toujours une pièce déjà enregistrée avec un autre contenu", async () => {
    const state = fixture();
    const file = await preparedFile(state);
    await submitInformationAgentContribution({
      missionId: MISSION_ID,
      input: submission(file),
      env: ENV,
    });
    state.assets[0]!.sha256 = "0".repeat(64);

    await expect(
      submitInformationAgentContribution({
        missionId: MISSION_ID,
        input: submission(file, {
          submissionId: "88888888-8888-4888-8888-888888888888",
          note: "Autre réponse.",
        }),
        env: ENV,
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("dit quel champ est en cause quand la réponse est trop longue pour être enregistrée", async () => {
    const state = fixture();
    const file = await preparedFile(state);
    // 10 000 caractères de réponse + 5 liens de 2 000 caractères : plus de 16 000 une fois assemblés.
    const links = Array.from(
      { length: 5 },
      (_, index) => `https://exemple.test/${index}/${"a".repeat(1990)}`,
    );

    await expect(
      submitInformationAgentContribution({
        missionId: MISSION_ID,
        input: submission(file, { note: "x".repeat(10_000), externalLinks: links, files: [] }),
        env: ENV,
      }),
    ).rejects.toMatchObject({ status: 400, field: "note" });
  });
});
