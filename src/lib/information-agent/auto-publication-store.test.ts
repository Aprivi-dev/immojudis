import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));

import {
  runAutoPublicationSimulation,
  runAutoPublicationSimulationForCron,
} from "./auto-publication-store";

type Result = { data: unknown; error: unknown };

/** Faux client : chaque table rend la réponse configurée, quelle que soit la requête. */
let tables: Record<string, Result>;

function query(table: string) {
  const chain: Record<string, unknown> = {};
  for (const name of ["select", "eq", "in", "gte", "order", "range", "limit"]) {
    chain[name] = () => chain;
  }
  chain.maybeSingle = () => Promise.resolve(tables[`${table}:single`] ?? tables[table]);
  chain.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve(tables[table] ?? { data: [], error: null }).then(resolve);
  return chain;
}

const FACT = {
  id: "fact-1",
  case_id: "case-1",
  message_id: "message-1",
  sale_id: "sale-1",
  fact_key: "surface_m2",
  status: "pending",
  evidence_asset_id: null,
  reviewed_by: null,
  proposed_value: { value: 54 },
  metadata: { semantic_agreement: true, semantic_extraction_method: "semantic_evidence_v3" },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.from.mockImplementation(query);
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  tables = {
    "information_agent_auto_publication_settings:single": {
      data: { mode: "simulation" },
      error: null,
    },
    information_agent_fact_candidates: { data: [FACT], error: null },
    information_agent_messages: {
      data: [
        {
          id: "message-1",
          direction: "inbound",
          received_at: "2026-11-03T10:00:00.000Z",
          subject: "Re: demande",
          body_text: "La surface habitable est de 54 m².",
          metadata: {
            imported_manually: false,
            sender_matches_recipient: true,
            sender_authentication: { dkim: "pass", dmarc: "pass" },
            inbound_processing: { status: "completed" },
          },
        },
      ],
      error: null,
    },
    information_agent_cases: {
      data: [
        { id: "case-1", sent_at: "2026-11-01T09:00:00.000Z", recipient_kind: "source_lawyer" },
      ],
      error: null,
    },
    auction_sales: {
      data: [
        {
          id: "sale-1",
          property_type: "apartment",
          surface_m2: null,
          app_surface_m2: null,
          land_surface_m2: null,
          rooms_count: null,
        },
      ],
      error: null,
    },
    information_agent_auto_publication_decisions: { data: [], error: null },
  };
});

describe("passe de simulation", () => {
  it("mode arrêt : rien n'est lu ni calculé", async () => {
    tables["information_agent_auto_publication_settings:single"] = {
      data: { mode: "off" },
      error: null,
    };
    expect(await runAutoPublicationSimulation()).toEqual({ status: "inactive", mode: "off" });
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("un réglage illisible lève une erreur (le cron la signale)", async () => {
    tables["information_agent_auto_publication_settings:single"] = { data: null, error: null };
    await expect(runAutoPublicationSimulation()).rejects.toThrow(/absent ou illisible/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("simulation : la décision est inscrite au journal par la RPC de service, rien d'autre n'est écrit", async () => {
    const result = await runAutoPublicationSimulation({ now: new Date("2026-11-03T12:00:00Z") });
    expect(result).toMatchObject({ status: "done", examined: 1, recorded: 1, wouldPublish: 1 });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("record_information_agent_auto_publication_decision", {
      p_fact_id: "fact-1",
      p_fact_key: "surface_m2",
      p_outcome: "would_publish",
      p_reasons: [],
      p_policy_version: "auto_publication_v1",
    });
  });

  it("une lecture de contexte en échec donne « relecture » et est signalée", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    tables.auction_sales = { data: null, error: { code: "57014" } };
    const result = await runAutoPublicationSimulation({ now: new Date("2026-11-03T12:00:00Z") });
    expect(result).toMatchObject({ status: "done", wouldPublish: 0, review: 1, unreadable: 1 });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_information_agent_auto_publication_decision",
      expect.objectContaining({
        p_outcome: "review",
        p_reasons: expect.arrayContaining(["input_unreadable"]),
      }),
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining("57014"));
    error.mockRestore();
  });

  it("pour le cron, un échec de la passe est rendu avec son seul code et signalé", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    tables["information_agent_auto_publication_settings:single"] = {
      data: null,
      error: { code: "PGRST301", message: "détail interne" },
    };
    expect(await runAutoPublicationSimulationForCron()).toEqual({
      status: "failed",
      code: "PGRST301",
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("PGRST301"));
    error.mockRestore();
  });

  it("une décision non écrite est comptée pour faire échouer le cron", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "23514" } });
    const result = await runAutoPublicationSimulation({ now: new Date("2026-11-03T12:00:00Z") });
    expect(result).toMatchObject({ status: "done", recorded: 0, recordFailed: 1 });
    error.mockRestore();
  });
});
