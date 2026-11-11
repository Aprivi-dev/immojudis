import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));

import {
  AutoPublicationPassError,
  loadLatestAutoPublicationDecisions,
  runAutoPublicationSimulation,
  runAutoPublicationSimulationForCron,
} from "./auto-publication-store";

type Row = Record<string, unknown>;

/**
 * Faux client PostgREST en mémoire : il honore `eq`, `in`, `gte`, `order`, `range` et `limit`, plafonne
 * toute réponse à `maxRows` lignes comme `max-rows` (valeur inconnue en production : les tests la baissent),
 * et rend le total exact demandé par `count: "exact"`. Une table peut être forcée en erreur, éventuellement
 * pour les seules requêtes qui portent un filtre donné.
 */
let db: Record<string, Row[]>;
let failures: Record<string, { code: string; whenFilter?: string }>;
let queries: Array<{ table: string; filters: string[] }>;
let maxRows: number;

function query(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  const described: string[] = [];
  const orders: Array<[string, boolean]> = [];
  let from = 0;
  let to = Number.POSITIVE_INFINITY;
  let limit = Number.POSITIVE_INFINITY;
  let counted = false;
  const run = () => {
    queries.push({ table, filters: described });
    const failure = failures[table];
    if (failure && (!failure.whenFilter || described.includes(failure.whenFilter))) {
      return { data: null, error: { code: failure.code }, count: null };
    }
    let rows = (db[table] ?? []).filter((row) => filters.every((filter) => filter(row)));
    const total = rows.length;
    rows = [...rows].sort((left, right) => {
      for (const [column, ascending] of orders) {
        const a = String(left[column] ?? "");
        const b = String(right[column] ?? "");
        if (a !== b) return (a < b ? -1 : 1) * (ascending ? 1 : -1);
      }
      return 0;
    });
    rows = rows.slice(from, Math.min(to + 1, rows.length));
    rows = rows.slice(0, Math.min(limit, maxRows));
    return { data: rows, error: null, count: counted ? total : null };
  };
  const chain: Record<string, unknown> = {
    select: (_columns: string, options?: { count?: string }) => {
      counted = options?.count === "exact";
      return chain;
    },
    eq: (column: string, value: unknown) => {
      described.push(`eq:${column}`);
      filters.push((row) => row[column] === value);
      return chain;
    },
    in: (column: string, values: unknown[]) => {
      described.push(`in:${column}`);
      filters.push((row) => values.includes(row[column]));
      return chain;
    },
    gte: (column: string, value: string) => {
      described.push(`gte:${column}`);
      filters.push((row) => String(row[column]) >= value);
      return chain;
    },
    order: (column: string, options?: { ascending?: boolean }) => {
      orders.push([column, options?.ascending ?? true]);
      return chain;
    },
    range: (start: number, end: number) => {
      from = start;
      to = end;
      return chain;
    },
    limit: (count: number) => {
      limit = count;
      return chain;
    },
    maybeSingle: () => {
      const result = run();
      return Promise.resolve({ data: result.data?.[0] ?? null, error: result.error });
    },
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(run()).then(resolve),
  };
  return chain;
}

const NOW = new Date("2026-11-20T12:00:00Z");
let sequence = 0;

function uuid(prefix: string) {
  sequence += 1;
  return `${prefix}-${String(sequence).padStart(6, "0")}`;
}

/** Un dossier « propre » : vente vide, dossier répondu, message authentifié, fait net. */
function seedCleanFact({
  factKey = "surface_m2",
  value = 54,
  createdAt = "2026-11-19T10:00:00Z",
}: { factKey?: string; value?: number; createdAt?: string } = {}) {
  const saleId = uuid("sale");
  const caseId = uuid("case");
  const messageId = uuid("message");
  const factId = uuid("fact");
  db.auction_sales!.push({
    id: saleId,
    property_type: "house",
    surface_m2: null,
    app_surface_m2: null,
    habitable_surface_m2: null,
    carrez_surface_m2: null,
    land_surface_m2: null,
    rooms_count: null,
  });
  db.information_agent_cases!.push({
    id: caseId,
    sent_at: "2026-11-18T09:00:00Z",
    recipient_kind: "source_lawyer",
    status: "replied",
  });
  db.information_agent_messages!.push({
    id: messageId,
    case_id: caseId,
    direction: "inbound",
    received_at: "2026-11-19T09:00:00Z",
    created_at: "2026-11-19T09:00:00Z",
    subject: "Re: demande",
    body_text: "La surface habitable est de 54 m².",
    metadata: {
      imported_manually: false,
      sender_matches_recipient: true,
      sender_authentication: { dkim: "pass", dmarc: "pass" },
      inbound_processing: { status: "completed" },
    },
  });
  db.information_agent_fact_candidates!.push({
    id: factId,
    case_id: caseId,
    message_id: messageId,
    sale_id: saleId,
    fact_key: factKey,
    status: "pending",
    evidence_asset_id: null,
    reviewed_by: null,
    proposed_value: { value },
    metadata: { semantic_agreement: true, semantic_extraction_method: "semantic_evidence_v3" },
    created_at: createdAt,
  });
  return { saleId, caseId, messageId, factId };
}

function decision(row: Row) {
  db.information_agent_auto_publication_decisions!.push({
    id: uuid("decision"),
    policy_version: "auto_publication_v1",
    ...row,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  sequence = 0;
  queries = [];
  failures = {};
  maxRows = 1000;
  db = {
    information_agent_auto_publication_settings: [{ singleton: true, mode: "simulation" }],
    information_agent_fact_candidates: [],
    information_agent_messages: [],
    information_agent_cases: [],
    auction_sales: [],
    information_agent_evidence_assets: [],
    information_agent_auto_publication_decisions: [],
  };
  mocks.from.mockImplementation(query);
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

function recorded() {
  return mocks.rpc.mock.calls.map(([, args]) => args as Record<string, unknown>);
}

describe("passe de simulation : modes", () => {
  it("mode arrêt : rien n'est lu ni calculé", async () => {
    db.information_agent_auto_publication_settings = [{ singleton: true, mode: "off" }];
    expect(await runAutoPublicationSimulation({ now: NOW })).toEqual({
      status: "inactive",
      mode: "off",
    });
    expect(queries.map((item) => item.table)).toEqual([
      "information_agent_auto_publication_settings",
    ]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("migration absente : « not_installed », sans échec du cron", async () => {
    failures.information_agent_auto_publication_settings = { code: "PGRST205" };
    expect(await runAutoPublicationSimulation({ now: NOW })).toEqual({ status: "not_installed" });
    expect(await runAutoPublicationSimulationForCron()).toEqual({ status: "not_installed" });
  });

  it("toute autre erreur du réglage est un échec, avec son seul code", async () => {
    failures.information_agent_auto_publication_settings = { code: "PGRST301" };
    await expect(runAutoPublicationSimulation({ now: NOW })).rejects.toMatchObject({
      code: "PGRST301",
    });
    expect(await runAutoPublicationSimulationForCron()).toEqual({
      status: "failed",
      code: "PGRST301",
    });
  });

  it("un réglage illisible lève une erreur", async () => {
    db.information_agent_auto_publication_settings = [];
    await expect(runAutoPublicationSimulation({ now: NOW })).rejects.toThrow(/absent ou illisible/);
  });
});

describe("passe de simulation : lecture filtrée", () => {
  it("ne lit que les faits en attente des champs de la liste fermée, et inscrit la décision", async () => {
    const { factId } = seedCleanFact();
    const other = seedCleanFact();
    db.information_agent_fact_candidates!.find((row) => row.id === other.factId)!.status =
      "conflict";
    const occupancy = seedCleanFact({ factKey: "occupancy_status" });
    const result = await runAutoPublicationSimulation({ now: NOW });
    expect(result).toMatchObject({ status: "done", examined: 1, recorded: 1, wouldPublish: 1 });
    expect(recorded()).toEqual([
      {
        p_fact_id: factId,
        p_fact_key: "surface_m2",
        p_outcome: "would_publish",
        p_reasons: [],
        p_policy_version: "auto_publication_v1",
      },
    ]);
    expect(recorded().some((args) => args.p_fact_id === occupancy.factId)).toBe(false);
  });

  it("pagine au-delà de 100 faits", async () => {
    for (let index = 0; index < 150; index += 1) {
      seedCleanFact({ createdAt: `2026-11-19T10:${String(index % 60).padStart(2, "0")}:00Z` });
    }
    const result = await runAutoPublicationSimulation({ now: NOW });
    expect(result).toMatchObject({ status: "done", examined: 150, truncated: false });
    expect(mocks.rpc).toHaveBeenCalledTimes(150);
  });

  it("une décision identique à la dernière du journal n'est pas réécrite", async () => {
    const { factId, caseId, saleId } = seedCleanFact();
    decision({
      fact_id: factId,
      case_id: caseId,
      sale_id: saleId,
      fact_key: "surface_m2",
      outcome: "would_publish",
      reasons: [],
      decided_at: "2026-11-20T08:00:00Z",
    });
    const result = await runAutoPublicationSimulation({ now: NOW });
    expect(result).toMatchObject({ unchanged: 1, recorded: 0 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("une lecture dont le total dépasse les lignes reçues est tronquée : relecture, signalée", async () => {
    maxRows = 300;
    const { saleId, messageId } = seedCleanFact();
    for (let index = 0; index < 300; index += 1) {
      db.information_agent_fact_candidates!.push({
        id: `noise-${String(index).padStart(5, "0")}`,
        case_id: "case-noise",
        message_id: messageId === "x" ? "y" : `noise-message-${index}`,
        sale_id: saleId,
        fact_key: "rooms_count",
        status: "rejected",
        proposed_value: { value: 3 },
        created_at: "2026-01-01T00:00:00Z",
      });
    }
    const result = await runAutoPublicationSimulation({ now: NOW });
    expect(result).toMatchObject({ wouldPublish: 0, unreadable: 1 });
    expect(recorded()[0]).toMatchObject({
      p_outcome: "review",
      p_reasons: expect.arrayContaining(["input_unreadable"]),
    });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("truncated"));
  });

  it("une valeur contradictoire dans un second message du dossier renvoie en relecture", async () => {
    const { saleId, caseId, factId } = seedCleanFact();
    db.information_agent_messages!.push({
      id: "message-erratum",
      case_id: caseId,
      direction: "inbound",
      received_at: "2026-11-19T11:00:00Z",
      created_at: "2026-11-19T11:00:00Z",
      subject: "Erratum",
      body_text: "Erratum : 48 m².",
      metadata: { inbound_processing: { status: "completed" } },
    });
    db.information_agent_fact_candidates!.push({
      id: "fact-erratum",
      case_id: caseId,
      message_id: "message-erratum",
      sale_id: saleId,
      fact_key: "surface_m2",
      status: "pending",
      evidence_asset_id: null,
      reviewed_by: null,
      proposed_value: { value: 48 },
      metadata: {},
      created_at: "2026-11-19T11:00:00Z",
    });
    await runAutoPublicationSimulation({ now: NOW });
    expect(recorded().find((args) => args.p_fact_id === factId)).toMatchObject({
      p_outcome: "review",
      p_reasons: expect.arrayContaining(["other_value_for_sale"]),
    });
  });

  it("le corps lu par l'IA seule porte son propre motif, pas « pièce jointe »", async () => {
    const { factId } = seedCleanFact();
    db.information_agent_fact_candidates!.find((row) => row.id === factId)!.evidence_asset_id =
      "asset-body";
    db.information_agent_evidence_assets!.push({
      id: "asset-body",
      metadata: { evidence_kind: "email_body" },
    });
    await runAutoPublicationSimulation({ now: NOW });
    const reasons = recorded()[0]!.p_reasons as string[];
    expect(reasons).toContain("semantic_only_body");
    expect(reasons).not.toContain("attachment_source");
  });

  it("une lecture de contexte en échec donne « relecture » et est signalée", async () => {
    seedCleanFact();
    failures.auction_sales = { code: "57014" };
    const result = await runAutoPublicationSimulation({ now: NOW });
    expect(result).toMatchObject({ status: "done", wouldPublish: 0, review: 1, unreadable: 1 });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("57014"));
  });
});

describe("passe de simulation : plafonds", () => {
  it("un fait « publié » un jour antérieur sort du lot : il ne pèse pas sur le plafond du jour", async () => {
    for (let index = 0; index < 10; index += 1) {
      const old = seedCleanFact();
      decision({
        fact_id: old.factId,
        case_id: old.caseId,
        sale_id: old.saleId,
        fact_key: "surface_m2",
        outcome: "would_publish",
        reasons: [],
        decided_at: "2026-11-19T15:00:00Z",
      });
    }
    seedCleanFact();
    const result = await runAutoPublicationSimulation({ now: NOW });
    expect(result).toMatchObject({ examined: 11, frozen: 10, wouldPublish: 1, recorded: 1 });
  });

  it("le champ d'un fait « publié » un jour antérieur reste rempli, et son dossier compte", async () => {
    const first = seedCleanFact();
    decision({
      fact_id: first.factId,
      case_id: first.caseId,
      sale_id: first.saleId,
      fact_key: "surface_m2",
      outcome: "would_publish",
      reasons: [],
      decided_at: "2026-11-18T15:00:00Z",
    });
    // Second fait, même vente et même champ, dans un autre message du même dossier.
    db.information_agent_messages!.push({
      id: "message-2",
      case_id: first.caseId,
      direction: "inbound",
      received_at: "2026-11-19T08:00:00Z",
      created_at: "2026-11-19T08:00:00Z",
      subject: "Re",
      body_text: "54 m².",
      metadata: {
        imported_manually: false,
        sender_matches_recipient: true,
        sender_authentication: { dkim: "pass", dmarc: "pass" },
        inbound_processing: { status: "completed" },
      },
    });
    db.information_agent_fact_candidates!.push({
      id: "fact-2",
      case_id: first.caseId,
      message_id: "message-2",
      sale_id: first.saleId,
      fact_key: "surface_m2",
      status: "pending",
      evidence_asset_id: null,
      reviewed_by: null,
      proposed_value: { value: 54 },
      metadata: { semantic_agreement: true, semantic_extraction_method: "semantic_evidence_v3" },
      created_at: "2026-11-19T08:00:00Z",
    });
    const result = await runAutoPublicationSimulation({ now: NOW });
    expect(result).toMatchObject({ frozen: 1 });
    expect(recorded().find((args) => args.p_fact_id === "fact-2")).toMatchObject({
      p_outcome: "review",
      p_reasons: expect.arrayContaining(["field_already_filled_in_simulation"]),
    });
  });

  it("le plafond du jour compte les faits « publiés » aujourd'hui hors du lot", async () => {
    for (let index = 0; index < 10; index += 1) {
      decision({
        fact_id: `published-${index}`,
        case_id: `case-x-${index}`,
        sale_id: `sale-x-${index}`,
        fact_key: "surface_m2",
        outcome: "would_publish",
        reasons: [],
        decided_at: "2026-11-20T08:00:00Z",
      });
    }
    seedCleanFact();
    await runAutoPublicationSimulation({ now: NOW });
    expect(recorded()[0]).toMatchObject({ p_outcome: "review", p_reasons: ["daily_cap_reached"] });
  });
});

describe("passe de simulation : écriture bornée", () => {
  it("s'arrête après trois échecs consécutifs du même code", async () => {
    for (let index = 0; index < 5; index += 1) seedCleanFact();
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "23514" } });
    const result = await runAutoPublicationSimulation({ now: NOW });
    expect(result).toMatchObject({ recordFailed: 3, stoppedOnRepeatedError: true });
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
  });

  it("s'arrête quand le temps de la passe est épuisé, avec un statut explicite", async () => {
    for (let index = 0; index < 3; index += 1) seedCleanFact();
    let ticks = 0;
    const result = await runAutoPublicationSimulation({
      now: NOW,
      timeBudgetMs: 10,
      clock: () => (ticks++ < 2 ? 0 : 1_000),
    });
    expect(result).toMatchObject({ status: "time_limit_reached", timedOut: true });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});

describe("dernières décisions pour l'affichage", () => {
  it("rend la plus récente de chaque fait", async () => {
    decision({
      fact_id: "fact-a",
      outcome: "review",
      reasons: ["field_not_empty"],
      decided_at: "2026-11-19T08:00:00Z",
    });
    decision({
      fact_id: "fact-a",
      outcome: "would_publish",
      reasons: [],
      decided_at: "2026-11-20T08:00:00Z",
    });
    const latest = await loadLatestAutoPublicationDecisions(["fact-a", "fact-b"]);
    expect(latest.get("fact-a")).toMatchObject({ outcome: "would_publish" });
    expect(latest.has("fact-b")).toBe(false);
  });

  it("une lecture tronquée est une erreur, jamais « pas encore calculée »", async () => {
    maxRows = 300;
    for (let index = 0; index < 301; index += 1) {
      decision({
        fact_id: "fact-a",
        outcome: "review",
        reasons: ["field_not_empty"],
        decided_at: `2026-11-19T08:00:00.${String(index).padStart(3, "0")}Z`,
      });
    }
    await expect(loadLatestAutoPublicationDecisions(["fact-a", "fact-b"])).rejects.toThrow(
      /tronqué/,
    );
  });
});

describe("passe de simulation : état global illisible", () => {
  it("dernières décisions illisibles : échec sans rien écrire (le gel n'est pas défait)", async () => {
    const old = seedCleanFact();
    decision({
      fact_id: old.factId,
      case_id: old.caseId,
      sale_id: old.saleId,
      fact_key: "surface_m2",
      outcome: "would_publish",
      reasons: [],
      decided_at: "2026-11-19T15:00:00Z",
    });
    failures.information_agent_auto_publication_decisions = {
      code: "57014",
      whenFilter: "in:fact_id",
    };
    await expect(runAutoPublicationSimulation({ now: NOW })).rejects.toBeInstanceOf(
      AutoPublicationPassError,
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(await runAutoPublicationSimulationForCron()).toEqual({
      status: "failed",
      code: "decisions_unreadable",
    });
  });

  it("dernières décisions tronquées : échec sans rien écrire", async () => {
    maxRows = 300;
    const { factId, caseId, saleId } = seedCleanFact();
    for (let index = 0; index < 301; index += 1) {
      decision({
        fact_id: factId,
        case_id: caseId,
        sale_id: saleId,
        fact_key: "surface_m2",
        outcome: "review",
        reasons: ["field_not_empty"],
        decided_at: `2026-11-19T08:00:00.${String(index).padStart(3, "0")}Z`,
      });
    }
    await expect(runAutoPublicationSimulation({ now: NOW })).rejects.toMatchObject({
      code: "decisions_unreadable",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("compteurs illisibles : échec sans rien écrire", async () => {
    seedCleanFact();
    failures.information_agent_auto_publication_decisions = {
      code: "57014",
      whenFilter: "eq:outcome",
    };
    await expect(runAutoPublicationSimulation({ now: NOW })).rejects.toMatchObject({
      code: "counters_unreadable",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("passe de simulation : branchements prouvés", () => {
  it("le compteur par dossier compte les faits figés : un troisième fait sort en plafond du dossier", async () => {
    const first = seedCleanFact({ factKey: "surface_m2", value: 90 });
    for (const [factKey, id] of [
      ["surface_m2", first.factId],
      ["land_surface_m2", "fact-land"],
    ] as const) {
      if (factKey === "land_surface_m2") {
        db.information_agent_fact_candidates!.push({
          ...db.information_agent_fact_candidates!.find((row) => row.id === first.factId)!,
          id,
          fact_key: factKey,
          proposed_value: { value: 600 },
          created_at: "2026-11-19T10:01:00Z",
        });
      }
      decision({
        fact_id: id,
        case_id: first.caseId,
        sale_id: first.saleId,
        fact_key: factKey,
        outcome: "would_publish",
        reasons: [],
        decided_at: "2026-11-18T15:00:00Z",
      });
    }
    db.information_agent_fact_candidates!.push({
      ...db.information_agent_fact_candidates!.find((row) => row.id === first.factId)!,
      id: "fact-rooms",
      fact_key: "rooms_count",
      proposed_value: { value: 4 },
      created_at: "2026-11-19T10:02:00Z",
    });
    const result = await runAutoPublicationSimulation({ now: NOW });
    expect(result).toMatchObject({ frozen: 2 });
    expect(recorded()).toEqual([
      expect.objectContaining({
        p_fact_id: "fact-rooms",
        p_outcome: "review",
        p_reasons: ["case_cap_reached"],
      }),
    ]);
  });

  it("les messages postérieurs du dossier sont transmis au moteur", async () => {
    const { caseId, factId } = seedCleanFact();
    db.information_agent_messages!.push({
      id: "message-later",
      case_id: caseId,
      direction: "inbound",
      received_at: "2026-11-19T12:00:00Z",
      created_at: "2026-11-19T12:00:00Z",
      subject: "Re: demande",
      body_text: "Finalement, ne publiez pas cette surface.",
      metadata: { inbound_processing: { status: "completed" } },
    });
    await runAutoPublicationSimulation({ now: NOW });
    expect(recorded().find((args) => args.p_fact_id === factId)).toMatchObject({
      p_outcome: "review",
      p_reasons: expect.arrayContaining(["later_message_in_case"]),
    });
  });

  it("un message reçu à la même seconde, écrit après, compte comme postérieur", async () => {
    const { caseId, factId } = seedCleanFact();
    db.information_agent_messages!.push({
      id: "message-same-second",
      case_id: caseId,
      direction: "inbound",
      received_at: "2026-11-19T09:00:00Z",
      created_at: "2026-11-19T09:00:01Z",
      subject: "Re: demande",
      body_text: "Ne publiez pas, merci.",
      metadata: { inbound_processing: { status: "completed" } },
    });
    await runAutoPublicationSimulation({ now: NOW });
    expect(recorded().find((args) => args.p_fact_id === factId)).toMatchObject({
      p_reasons: expect.arrayContaining(["later_message_in_case"]),
    });
  });

  it("les faits voisins ne sont lus que pour les champs de la liste fermée", async () => {
    seedCleanFact();
    await runAutoPublicationSimulation({ now: NOW });
    const related = queries.filter(
      (item) =>
        item.table === "information_agent_fact_candidates" && item.filters.includes("in:sale_id"),
    );
    expect(related.length).toBeGreaterThan(0);
    for (const item of related) expect(item.filters).toContain("in:fact_key");
    const open = queries.filter(
      (item) =>
        item.table === "information_agent_fact_candidates" && item.filters.includes("eq:status"),
    );
    for (const item of open) expect(item.filters).toContain("in:fact_key");
  });

  it("une pagination plus courte que demandé (plafond serveur bas) ne fait sauter aucun fait", async () => {
    maxRows = 30;
    for (let index = 0; index < 70; index += 1) {
      seedCleanFact({ createdAt: `2026-11-19T10:${String(index % 60).padStart(2, "0")}:00Z` });
    }
    const result = await runAutoPublicationSimulation({ now: NOW });
    expect(result).toMatchObject({ examined: 70, truncated: false });
  });
});
