import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  log: [] as string[],
  inserts: [] as Array<{ table: string; rows: Row[]; options?: unknown }>,
  failTable: null as string | null,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  function builder(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let mode: "select" | "delete" | "insert" = "select";
    let head = false;
    let pageRange: [number, number] | null = null;
    const run = () => {
      if (state.failTable === table) {
        return { data: null, count: null, error: { message: "boom" } };
      }
      const rows = state.tables[table] ?? [];
      const matching = rows.filter((row) => filters.every((filter) => filter(row)));
      if (mode === "delete") {
        state.log.push(`delete:${table}:${matching.length}`);
        state.tables[table] = rows.filter((row) => !matching.includes(row));
        return { data: null, count: matching.length, error: null };
      }
      if (mode === "insert") return { data: null, count: null, error: null };
      const page = pageRange ? matching.slice(pageRange[0], pageRange[1] + 1) : matching;
      return { data: head ? null : page, count: matching.length, error: null };
    };
    const api: Record<string, unknown> = {
      select: (_columns: string, options?: { head?: boolean }) => {
        head = Boolean(options?.head);
        return api;
      },
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return api;
      },
      is: (column: string, value: unknown) => {
        filters.push((row) => (row[column] ?? null) === value);
        return api;
      },
      in: (column: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[column]));
        return api;
      },
      ilike: (column: string, pattern: string) => {
        // `_` and `%` are wildcards unless escaped with a backslash.
        let source = "";
        for (let index = 0; index < pattern.length; index++) {
          const char = pattern[index]!;
          if (char === "\\") {
            source += (pattern[++index] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          } else if (char === "%") source += ".*";
          else if (char === "_") source += ".";
          else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
        const expression = new RegExp(`^${source}$`, "i");
        filters.push((row) => expression.test(String(row[column] ?? "")));
        return api;
      },
      order: () => api,
      range: (from: number, to: number) => {
        pageRange = [from, to];
        return api;
      },
      delete: () => {
        mode = "delete";
        return api;
      },
      insert: (rows: Row | Row[], options?: unknown) => {
        mode = "insert";
        state.inserts.push({ table, rows: Array.isArray(rows) ? rows : [rows], options });
        return api;
      },
      upsert: (rows: Row | Row[], options?: unknown) => {
        mode = "insert";
        state.inserts.push({ table, rows: Array.isArray(rows) ? rows : [rows], options });
        state.log.push(`upsert:${table}`);
        return api;
      },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    };
    return api;
  }
  return { supabaseAdmin: { from: builder } };
});

import {
  collectProfessionalData,
  createProfessionalPrivacyRequest,
  eraseProfessionalData,
  PROFESSIONAL_PRIVACY_SOURCE,
} from "./information-agent-professional-rights";

const EMAIL = "Maitre_Dupont@Cabinet.example";
const CASE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CASE_ID = "22222222-2222-4222-8222-222222222222";
const MISSION_ID = "33333333-3333-4333-8333-333333333333";
const LOOKALIKE_MISSION_ID = "44444444-4444-4444-8444-444444444444";

function seed() {
  state.tables = {
    information_agent_cases: [
      { id: CASE_ID, normalized_recipient_email: "maitre_dupont@cabinet.example" },
      { id: OTHER_CASE_ID, normalized_recipient_email: "autre@cabinet.example" },
    ],
    information_agent_missions: [
      { id: MISSION_ID, recipient_email: "Maitre_Dupont@cabinet.example" },
      // `_` is a wildcard in LIKE: this other address must never be selected.
      { id: LOOKALIKE_MISSION_ID, recipient_email: "maitreXdupont@cabinet.example" },
    ],
    information_agent_messages: [
      { id: "m1", case_id: CASE_ID, mission_id: MISSION_ID, created_at: "2026-01-02T00:00:00Z" },
      {
        id: "m2",
        case_id: OTHER_CASE_ID,
        mission_id: LOOKALIKE_MISSION_ID,
        created_at: "2026-01-03",
      },
    ],
    information_agent_evidence_assets: [
      {
        case_id: CASE_ID,
        storage_bucket: "information-agent-evidence",
        storage_path: `${CASE_ID}/inbound/m1/pv.pdf`,
        metadata: { approved_public_path: "sale/pv.pdf" },
      },
      {
        case_id: OTHER_CASE_ID,
        storage_bucket: "information-agent-evidence",
        storage_path: `${OTHER_CASE_ID}/inbound/m2/autre.pdf`,
        metadata: {},
      },
    ],
    information_agent_fact_candidates: [],
    information_agent_evidence_extractions: [],
    information_agent_contacts: [
      { id: "c1", normalized_email: "maitre_dupont@cabinet.example", email: "x" },
    ],
    data_subject_requests: [],
  };
  state.log = [];
  state.inserts = [];
  state.failTable = null;
}

beforeEach(seed);

describe("createProfessionalPrivacyRequest", () => {
  it("enregistre une demande vérifiée sans compte, au nom de l'adresse normalisée", async () => {
    await expect(
      createProfessionalPrivacyRequest({ email: EMAIL, requestType: "erasure" }),
    ).resolves.toEqual({ created: true });
    const insert = state.inserts.find((entry) => entry.table === "data_subject_requests");
    expect(insert?.rows[0]).toMatchObject({
      user_id: null,
      requester_email: "maitre_dupont@cabinet.example",
      request_type: "erasure",
      identity_status: "verified",
      metadata: { source: PROFESSIONAL_PRIVACY_SOURCE },
    });
  });

  it("ne duplique pas une demande ouverte du même type pour la même adresse", async () => {
    state.tables.data_subject_requests = [
      {
        id: "r1",
        user_id: null,
        requester_email: "maitre_dupont@cabinet.example",
        request_type: "access",
        status: "received",
      },
    ];
    await expect(
      createProfessionalPrivacyRequest({ email: EMAIL, requestType: "access" }),
    ).resolves.toEqual({ created: false });
    expect(state.inserts).toEqual([]);
    // Une demande d'un autre type reste possible.
    await expect(
      createProfessionalPrivacyRequest({ email: EMAIL, requestType: "erasure" }),
    ).resolves.toEqual({ created: true });
  });
});

describe("collectProfessionalData", () => {
  it("couvre dossiers, demandes, messages, pièces et registre, sans une autre adresse", async () => {
    const data = await collectProfessionalData(EMAIL);
    expect(data.email).toBe("maitre_dupont@cabinet.example");
    expect(data.cases).toHaveLength(1);
    expect(data.requests).toHaveLength(1);
    expect(data.requests[0]).toMatchObject({ id: MISSION_ID });
    expect(data.messages.map((message) => message.id)).toEqual(["m1"]);
    expect(data.files).toHaveLength(1);
    expect(data.contacts).toHaveLength(1);
  });
});

describe("eraseProfessionalData", () => {
  it("met les fichiers en file, enregistre l'opposition puis efface dossiers et demandes", async () => {
    const report = await eraseProfessionalData(EMAIL);

    expect(report).toEqual({
      deletedRows: { information_agent_cases: 1, information_agent_missions: 1 },
      storageObjectsQueued: 1,
      oppositionRecorded: true,
    });
    const queued = state.inserts.find((entry) => entry.table === "sale_retention_storage_queue");
    expect(queued?.rows).toEqual([
      { bucket: "information-agent-evidence", object_path: `${CASE_ID}/inbound/m1/pv.pdf` },
    ]);
    // Ordre : fichiers, opposition, puis suppressions.
    expect(state.log).toEqual([
      "upsert:sale_retention_storage_queue",
      "upsert:information_agent_contacts",
      "delete:information_agent_cases:1",
      "delete:information_agent_missions:1",
    ]);
    const opposition = state.inserts.find((entry) => entry.table === "information_agent_contacts");
    expect(opposition?.rows[0]).toMatchObject({
      email: "maitre_dupont@cabinet.example",
      opposition_status: "opposed",
      scope_sale_id: null,
    });
    // Les données d'un autre professionnel et la demande au nom approchant restent.
    expect((state.tables.information_agent_cases ?? []).map((row) => row.id)).toEqual([
      OTHER_CASE_ID,
    ]);
    expect((state.tables.information_agent_missions ?? []).map((row) => row.id)).toEqual([
      LOOKALIKE_MISSION_ID,
    ]);
  });

  it("n'efface rien si la mise en file des fichiers échoue", async () => {
    state.failTable = "sale_retention_storage_queue";
    await expect(eraseProfessionalData(EMAIL)).rejects.toThrow("Mise en file");
    expect(state.log.filter((entry) => entry.startsWith("delete:"))).toEqual([]);
    expect(state.tables.information_agent_cases).toHaveLength(2);
  });

  it("est idempotent : une seconde exécution n'efface plus rien", async () => {
    await eraseProfessionalData(EMAIL);
    const second = await eraseProfessionalData(EMAIL);
    expect(second.deletedRows).toEqual({
      information_agent_cases: 0,
      information_agent_missions: 0,
    });
    expect(second.storageObjectsQueued).toBe(0);
  });
});
