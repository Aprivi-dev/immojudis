import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  /** Lignes de `v_auction_sales_app` (ventes en ligne). */
  sales: [] as Row[],
  /** Réponse de `sync_sale_communes()` (recopie de `raw_payload.commune` faite dans la base). */
  syncCommunes: { n_with_code: 0, n_changed: 0, n_written: 0 },
  floodRows: [] as Row[] | null,
  communeRows: [] as Row[] | null,
  upserts: [] as Array<{ table: string; rows: Row[] }>,
  updates: [] as Array<{ saleId: unknown; changes: Row }>,
  writeError: null as { code?: string; message: string } | null,
  /** Envois successifs de verdicts : `true` = refusé comme bloqué par un verrou de ligne (57014). */
  busyFloodUpserts: [] as boolean[],
  /** Ventes dont la ligne est refusée par la base (22008, date invalide) : tout envoi qui en contient échoue. */
  rejectedSaleIds: [] as string[],
  /** Erreur de la seule mise à jour d'une ligne existante (les insertions passent). */
  updateError: null as { code?: string; message: string } | null,
  tables: [] as string[],
  /** Lectures de `v_auction_sales_app` : filtres d'égalité et curseur. */
  salesReads: [] as Array<{ filters: Record<string, unknown>; after: string | null }>,
  /** Bail du traitement : `true` = une autre passe le tient ; `"missing"` = fonction absente (migration en retard). */
  leaseHeld: false as boolean | "missing",
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => new FakeQuery(table),
    rpc: async (name: string, args: unknown) => {
      db.rpcCalls.push({ name, args });
      if (name === "claim_sale_flood_risk_lease") {
        if (db.leaseHeld === "missing") {
          return { data: null, error: { code: "PGRST202", message: "absente" } };
        }
        return { data: db.leaseHeld ? null : "lease-token", error: null };
      }
      if (name === "sync_sale_communes") return { data: [db.syncCommunes], error: null };
      return { data: true, error: null };
    },
  },
}));

/** Colonnes NOT NULL à valeur par défaut de `auction_sale_flood_risk` (migration 20261106100200). */
const FLOOD_NOT_NULL_WITH_DEFAULT = [
  "tri_scenarios",
  "ppri_checked",
  "attempted_at",
  "failure_count",
  "verdict_changed_at",
  "created_at",
  "updated_at",
];

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private page: [number, number] = [0, 999];
  private upsertRows: Row[] | null = null;
  private changes: Row | null = null;
  private eqValue: unknown = null;
  private eqFilters: Record<string, unknown> = {};
  private after: string | null = null;
  private max = 1000;
  private defaultToNull = true;

  constructor(private readonly table: string) {}

  select() {
    return this;
  }
  order() {
    return this;
  }
  eq(column: string, value: unknown) {
    this.eqValue = value;
    this.eqFilters[column] = value;
    return this;
  }
  gt(_column: string, value: string) {
    this.after = value;
    return this;
  }
  limit(count: number) {
    this.max = count;
    return this;
  }
  range(from: number, to: number) {
    this.page = [from, to];
    return this;
  }
  upsert(rows: Row[], options?: { defaultToNull?: boolean }) {
    this.upsertRows = rows;
    this.defaultToNull = options?.defaultToNull ?? true;
    return this;
  }
  update(changes: Row) {
    this.changes = changes;
    return this;
  }

  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }

  private run(): { data: unknown; error: unknown } {
    db.tables.push(this.table);
    const missing = { code: "PGRST205", message: "Could not find the table" };
    if (this.upsertRows) {
      if (db.writeError) return { data: null, error: db.writeError };
      if (
        this.table === "auction_sale_flood_risk" &&
        this.upsertRows.some((row) => db.rejectedSaleIds.includes(String(row.sale_id)))
      ) {
        return {
          data: null,
          error: { code: "22008", message: "date/time field value out of range" },
        };
      }
      if (this.table === "auction_sale_flood_risk" && db.busyFloodUpserts.shift()) {
        return { data: null, error: { code: "57014", message: "statement timeout" } };
      }
      // Comme PostgREST : dans un envoi groupé, une colonne absente d'une ligne mais présente dans une autre vaut
      // NULL, pas sa valeur par défaut, sauf avec `defaultToNull: false` (« Prefer: missing=default »).
      if (this.table === "auction_sale_flood_risk" && this.defaultToNull) {
        const columns = new Set(this.upsertRows.flatMap((row) => Object.keys(row)));
        const nullsNotNull = FLOOD_NOT_NULL_WITH_DEFAULT.some(
          (column) => columns.has(column) && this.upsertRows!.some((row) => row[column] == null),
        );
        if (nullsNotNull) return { data: null, error: { code: "23502", message: "not-null" } };
      }
      if (
        (this.table === "auction_sale_flood_risk" && db.floodRows == null) ||
        (this.table === "auction_sale_communes" && db.communeRows == null)
      ) {
        return { data: null, error: missing };
      }
      db.upserts.push({ table: this.table, rows: this.upsertRows });
      return { data: null, error: null };
    }
    if (this.changes) {
      if (db.updateError ?? db.writeError)
        return { data: null, error: db.updateError ?? db.writeError };
      db.updates.push({ saleId: this.eqValue, changes: this.changes });
      return { data: null, error: null };
    }
    const slice = (rows: Row[]) => rows.slice(this.page[0], this.page[1] + 1);
    switch (this.table) {
      case "v_auction_sales_app": {
        // Lecture par curseur sur `id`, filtrée par statut dans la base.
        db.salesReads.push({ filters: { ...this.eqFilters }, after: this.after });
        const rows = db.sales
          .filter((row) => !("status" in this.eqFilters) || row.status === this.eqFilters.status)
          .filter((row) => this.after == null || String(row.id) > this.after)
          .sort((left, right) => String(left.id).localeCompare(String(right.id)));
        return { data: rows.slice(0, this.max), error: null };
      }
      case "auction_sale_flood_risk":
        return db.floodRows == null
          ? { data: null, error: missing }
          : { data: slice(db.floodRows), error: null };
      case "auction_sale_communes":
        return db.communeRows == null
          ? { data: null, error: missing }
          : { data: slice(db.communeRows), error: null };
      default:
        return { data: [], error: null };
    }
  }
}

import { FLOOD_DERIVE_VERSION } from "./flood-risk";
import { floodPositionKey } from "./flood-risk-position.server";
import {
  FLOOD_CALL_TIMEOUT_MS,
  FLOOD_CONTROL_POINT,
  FLOOD_DEFAULT_TIME_BUDGET_MS,
  FLOOD_MAX_DURATION_MS,
  FLOOD_MIN_INTERVAL_MS,
  FLOOD_MIN_REMAINING_MS,
  WRITE_CHUNK,
  pickFloodPending,
  runSaleFloodRiskBatch,
} from "./sale-flood-risk-batch";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const FUTURE = "2026-12-20T10:00:00.000Z";
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const TOURS = { lat: 47.399, lon: 0.689 };

function sale(id: string, overrides: Row = {}): Row {
  return {
    id,
    updated_at: daysAgo(3),
    status: "upcoming",
    sale_date: FUTURE,
    latitude: TOURS.lat,
    longitude: TOURS.lon,
    location_precision: "address",
    quality_flags: [],
    ...overrides,
  };
}

const COMMUNE = (saleId: string, insee = "37261") => ({
  sale_id: saleId,
  commune_insee: insee,
  arrondissement_insee: null,
});

type ApiState = {
  /** Scénarios rendus par `tri_zonage`, par appel (une entrée par scénario). */
  scenarios: string[];
  ppri: "in" | "out" | "fail";
  triStatus: number;
  communeHasTri: boolean;
  communeStatus: number;
  /** Scénarios rendus au point de contrôle connu (Garonne à Toulouse) : `01For` tant que la source va bien. */
  controlScenarios: string[];
  controlStatus: number;
};

const CONTROL_LATLON = `${FLOOD_CONTROL_POINT.longitude},${FLOOD_CONTROL_POINT.latitude}`;
/** L'appel est celui du point de contrôle connu (Garonne à Toulouse), pas celui d'une vente. */
const isControlUrl = (url: string) =>
  url.includes("/tri_zonage") && new URL(url).searchParams.get("latlon") === CONTROL_LATLON;
/** La réponse du point de contrôle quand la source va bien : le scénario `01For`. */
const controlAnswer = () =>
  new Response(
    JSON.stringify({ results: 1, data: [{ code_national_tri: "X", scenario: { code: "01For" } }] }),
    { status: 200 },
  );

function makeApi(overrides: Partial<ApiState> = {}) {
  const state: ApiState = {
    scenarios: [],
    ppri: "out",
    triStatus: 200,
    communeHasTri: false,
    communeStatus: 200,
    controlScenarios: ["01For"],
    controlStatus: 200,
    ...overrides,
  };
  const calls: string[] = [];
  /** Appels au point de contrôle : à part, pour ne pas fausser le décompte des appels des ventes. */
  const controlCalls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const ok = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (
      url.includes("/tri_zonage") &&
      new URL(url).searchParams.get("latlon") ===
        `${FLOOD_CONTROL_POINT.longitude},${FLOOD_CONTROL_POINT.latitude}`
    ) {
      controlCalls.push(url);
      if (state.controlStatus !== 200) return new Response("{}", { status: state.controlStatus });
      return ok({
        results: state.controlScenarios.length,
        data: state.controlScenarios.map((code) => ({
          code_national_tri: "X",
          scenario: { code },
          date_arrete_carte: "03/12/2014",
        })),
      });
    }
    calls.push(url);
    headers.push((init?.headers ?? {}) as Record<string, string>);
    if (url.includes("/tri_zonage")) {
      if (state.triStatus !== 200) return new Response("{}", { status: state.triStatus });
      return ok({
        results: state.scenarios.length,
        data: state.scenarios.map((code) => ({
          code_national_tri: "X",
          scenario: { code },
          date_arrete_carte: "18/12/2013",
        })),
      });
    }
    if (url.includes("/gaspar/tri")) {
      if (state.communeStatus !== 200) return new Response("{}", { status: state.communeStatus });
      return ok({
        results: state.communeHasTri ? 1 : 0,
        data: state.communeHasTri ? [{ code_national_tri: "X", libelle_tri: "T" }] : [],
      });
    }
    if (url.includes("generateur-sup-s")) {
      if (state.ppri === "fail") return new Response("{}", { status: 503 });
      return ok({
        type: "FeatureCollection",
        features: state.ppri === "in" ? [{ properties: { code_alea: "11" } }] : [],
      });
    }
    return new Response("{}", { status: 404 });
  };
  return { state, calls, controlCalls, headers, fetcher };
}

const run = (
  api: ReturnType<typeof makeApi>,
  options: Parameters<typeof runSaleFloodRiskBatch>[0] = {},
) =>
  runSaleFloodRiskBatch({
    now: NOW,
    api: { fetcher: api.fetcher, pace: async () => undefined },
    communeCache: new Map(),
    ...options,
  });

const written = () =>
  db.upserts
    .filter((upsert) => upsert.table === "auction_sale_flood_risk")
    .flatMap((upsert) => upsert.rows);

beforeEach(() => {
  db.sales = [];
  db.syncCommunes = { n_with_code: 0, n_changed: 0, n_written: 0 };
  db.salesReads = [];
  db.floodRows = [];
  db.communeRows = [];
  db.upserts = [];
  db.updates = [];
  db.writeError = null;
  db.busyFloodUpserts = [];
  db.rejectedSaleIds = [];
  db.updateError = null;
  db.tables = [];
  db.leaseHeld = false;
  db.rpcCalls = [];
});

describe("runSaleFloodRiskBatch : observations", () => {
  it("position précise dans la zone de crue fréquente d'un TRI : risque élevé, sans coordonnée dans la ligne", async () => {
    db.sales = [sale("a")];
    const api = makeApi({ scenarios: ["01For"], ppri: "in" });

    const result = await run(api);

    expect(result).toMatchObject({
      skipped: null,
      upcoming: 1,
      pending: 1,
      observed: 1,
      failed: 0,
      rateLimited: false,
      verdicts: { high: 1 },
    });
    const [row] = written();
    expect(row).toMatchObject({
      sale_id: "a",
      verdict: "high",
      derive_version: FLOOD_DERIVE_VERSION,
      position_kind: "point",
      tri_scenarios: [["01For"]],
      ppri_perimeter: true,
      ppri_checked: true,
      map_date: "2013-12-18",
      observed_at: NOW.toISOString(),
      attempted_at: NOW.toISOString(),
      failure_count: 0,
      last_failure: null,
    });
    // Aucune coordonnée copiée : la position n'est qu'une empreinte.
    expect(JSON.stringify(row)).not.toMatch(/47\.39|0\.689/);
    expect(String(row.position_key)).toMatch(/^point:address:[0-9a-f]{16}$/);
    // Une seule requête TRI et une seule requête PPRi, avec un User-Agent.
    expect(api.calls.filter((url) => url.includes("tri_zonage"))).toHaveLength(1);
    expect(api.calls.filter((url) => url.includes("generateur-sup-s"))).toHaveLength(1);
    expect(api.headers[0]["User-Agent"]).toMatch(/^immojudis-flood-risk/);
  });

  it("hors zone de crue fréquente mais dans le périmètre d'un PPRi : exposé", async () => {
    db.sales = [sale("a")];
    await run(makeApi({ scenarios: ["04Fai"], ppri: "in" }));
    expect(written()[0]).toMatchObject({ verdict: "exposed", ppri_perimeter: true });
  });

  it("ni zone ni périmètre : aucun risque identifié", async () => {
    db.sales = [sale("a")];
    await run(makeApi());
    expect(written()[0]).toMatchObject({ verdict: "none_found", ppri_perimeter: false });
  });

  it("périmètre PPRi illisible : le verdict d'exclusion est écrit quand même, avec un nouvel essai prévu", async () => {
    db.sales = [sale("a")];
    const result = await run(makeApi({ ppri: "fail" }));
    expect(result.observed).toBe(1);
    expect(written()[0]).toMatchObject({
      verdict: "none_found",
      ppri_perimeter: null,
      ppri_checked: false,
    });
  });

  it("une rue : cinq points testés ; entièrement dans la zone, risque élevé", async () => {
    db.sales = [sale("a", { location_precision: "street" })];
    const api = makeApi({ scenarios: ["01For"] });
    await run(api);
    expect(api.calls.filter((url) => url.includes("tri_zonage"))).toHaveLength(5);
    expect(written()[0]).toMatchObject({ verdict: "high", position_kind: "street" });
  });

  it("position imprécise (centre de commune) dans une commune qui a un TRI : inconnu, sans appel de position", async () => {
    db.sales = [sale("a", { location_precision: "municipality" })];
    db.communeRows = [COMMUNE("a")];
    const api = makeApi({ communeHasTri: true });

    await run(api);

    expect(written()[0]).toMatchObject({
      verdict: "unknown",
      position_kind: "approximate",
      commune_insee: "37261",
      commune_has_tri: true,
      position_key: "approx:37261",
    });
    // Le centre de commune n'est jamais envoyé : seule la commune est interrogée.
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toContain("/api/v1/gaspar/tri");
    expect(api.calls[0]).toContain("code_insee=37261");
    expect(api.calls.some((url) => url.includes("tri_zonage") || url.includes("apicarto"))).toBe(
      false,
    );
  });

  it("position imprécise dans une commune sans TRI : aucun signal", async () => {
    db.sales = [sale("a", { location_precision: null, latitude: null, longitude: null })];
    db.communeRows = [COMMUNE("a", "02691")];
    await run(makeApi({ communeHasTri: false }));
    expect(written()[0]).toMatchObject({ verdict: "no_signal", commune_has_tri: false });
  });

  it("drapeau de position douteuse : position imprécise même avec une adresse", async () => {
    db.sales = [sale("a", { quality_flags: ["unverified_source_coordinates"] })];
    db.communeRows = [COMMUNE("a")];
    const api = makeApi({ communeHasTri: true });
    await run(api);
    expect(written()[0]).toMatchObject({ verdict: "unknown", position_kind: "approximate" });
    expect(api.calls.some((url) => url.includes("tri_zonage"))).toBe(false);
  });

  it("position imprécise et commune inconnue : inconnu, sans aucun appel", async () => {
    db.sales = [sale("a", { location_precision: "municipality" })];
    const api = makeApi();
    await run(api);
    expect(written()[0]).toMatchObject({ verdict: "unknown", commune_has_tri: null });
    expect(api.calls).toHaveLength(0);
  });

  it("la réponse « la commune a-t-elle un TRI ? » est gardée par commune pendant la passe", async () => {
    db.sales = ["a", "b", "c"].map((id) => sale(id, { location_precision: "municipality" }));
    db.communeRows = ["a", "b", "c"].map((id) => COMMUNE(id));
    const api = makeApi({ communeHasTri: true });
    await run(api);
    expect(api.calls).toHaveLength(1);
    expect(written()).toHaveLength(3);
  });

  it("les arrondissements sont interrogés par leur commune (Paris : 75056)", async () => {
    db.sales = [sale("a", { location_precision: "municipality" })];
    db.communeRows = [{ sale_id: "a", commune_insee: "75056", arrondissement_insee: "75108" }];
    const api = makeApi({ communeHasTri: true });
    await run(api);
    expect(api.calls[0]).toContain("code_insee=75056");
  });

  it("ne regarde que les ventes à venir", async () => {
    db.sales = [
      sale("past", { status: "past" }),
      sale("old", { sale_date: "2026-01-01T10:00:00.000Z" }),
      sale("ok"),
    ];
    const api = makeApi();
    const result = await run(api);
    expect(result.upcoming).toBe(1);
    expect(written().map((row) => row.sale_id)).toEqual(["ok"]);
  });
});

describe("runSaleFloodRiskBatch : pannes et coupe-circuit", () => {
  function knownRow(saleId: string, overrides: Row = {}): Row {
    return {
      sale_id: saleId,
      verdict: "none_found",
      derive_version: FLOOD_DERIVE_VERSION,
      position_key: floodPositionKey({
        latitude: TOURS.lat,
        longitude: TOURS.lon,
        precision: "address",
        flags: [],
        communeInsee: null,
      }),
      commune_insee: null,
      observed_at: daysAgo(100),
      attempted_at: daysAgo(100),
      failure_count: 0,
      ppri_checked: true,
      map_date: "2013-12-18",
      verdict_changed_at: daysAgo(100),
      ...overrides,
    };
  }

  it("une source en panne n'écrase jamais un verdict connu : seule la tentative est consignée", async () => {
    db.sales = [sale("a"), sale("b")];
    // « a » à réobserver (plus de 90 jours), « b » jamais observée.
    db.floodRows = [knownRow("a")];
    const api = makeApi({ triStatus: 503 });

    // Aucune observation réussie : la passe est en échec (supervision), mais les tentatives sont consignées.
    await expect(run(api)).rejects.toThrow("http_503, http_503");
    // « a » : aucun remplacement de ligne, une mise à jour de la tentative seulement.
    expect(written().some((row) => row.sale_id === "a")).toBe(false);
    expect(db.updates).toEqual([
      {
        saleId: "a",
        changes: expect.objectContaining({ failure_count: 1, last_failure: "http_503" }),
      },
    ]);
    expect(Object.keys(db.updates[0].changes)).not.toContain("verdict");
    // « b » n'avait rien : une ligne « inconnu » sans observation, retentée plus tard.
    expect(written().find((row) => row.sale_id === "b")).toMatchObject({
      verdict: "unknown",
      observed_at: null,
      failure_count: 1,
      last_failure: "http_503",
    });
  });

  it("un paquet mêlant un verdict et une première tentative manquée s'écrit en entier (valeurs par défaut)", async () => {
    // Incident du 27/10/2026 : PostgREST mettait NULL dans les colonnes absentes de la ligne « inconnu »
    // (tri_scenarios, ppri_checked), d'où un refus 23502 de tout le paquet.
    db.sales = [sale("a"), sale("b", { latitude: 45.123, longitude: 1.456 })];
    const api = makeApi();
    const fetcher: typeof fetch = async (input, init) =>
      String(input).includes("tri_zonage") && String(input).includes("45.123")
        ? new Response("{}", { status: 503 })
        : api.fetcher(input, init);

    const result = await run({ ...api, fetcher });

    expect(result).toMatchObject({ observed: 1, failed: 1 });
    expect(written().map((row) => [row.sale_id, row.verdict])).toEqual([
      ["a", "none_found"],
      ["b", "unknown"],
    ]);
  });

  it("toutes les observations échouent : la passe est déclarée en échec (supervision cron.stale)", async () => {
    db.sales = [sale("a")];
    await expect(run(makeApi({ triStatus: 500 }))).rejects.toThrow(
      /Observation du risque d'inondation impossible : http_500/,
    );
  });

  it("un 429 arrête la passe : plus aucun appel, les ventes restantes sont reprises à la passe suivante", async () => {
    db.sales = ["a", "b", "c"].map((id, index) =>
      sale(id, { sale_date: `2026-12-2${index}T10:00:00.000Z` }),
    );
    let calls = 0;
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (isControlUrl(url)) return controlAnswer();
      calls += 1;
      if (calls === 1 && url.includes("tri_zonage")) {
        return new Response(JSON.stringify({ results: 0, data: [] }), { status: 200 });
      }
      if (url.includes("generateur-sup-s")) {
        return new Response(JSON.stringify({ type: "FeatureCollection", features: [] }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 429 });
    };

    const result = await runSaleFloodRiskBatch({
      now: NOW,
      api: { fetcher, pace: async () => undefined },
      communeCache: new Map(),
    });

    expect(result).toMatchObject({ rateLimited: true, observed: 1, remaining: 2 });
    // Un appel TRI réussi, son appel PPRi, puis le TRI de « b » refusé : « c » n'est jamais appelée.
    expect(calls).toBe(3);
    expect(written().map((row) => row.sale_id)).toEqual(["a"]);
    expect(db.updates).toEqual([]);
  });

  it("un 429 dès le premier appel : échec de la passe, rien d'écrit", async () => {
    db.sales = [sale("a")];
    const api = makeApi({ triStatus: 429 });
    await expect(run(api)).rejects.toThrow(/limite de débit \(429\)/);
    expect(written()).toEqual([]);
    expect(api.calls).toHaveLength(1);
  });

  it("un 429 de l'API Carto arrête aussi la passe", async () => {
    db.sales = [sale("a"), sale("b")];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (isControlUrl(url)) return controlAnswer();
      if (url.includes("tri_zonage")) {
        return new Response(JSON.stringify({ results: 0, data: [] }), { status: 200 });
      }
      return new Response("{}", { status: 429 });
    };
    await expect(
      runSaleFloodRiskBatch({
        now: NOW,
        api: { fetcher, pace: async () => undefined },
        communeCache: new Map(),
      }),
    ).rejects.toThrow(/429/);
  });

  it("les erreurs de la passe ne portent ni URL, ni coordonnée, ni identifiant de vente", async () => {
    db.sales = [sale("secret-sale-id")];
    const fetcher: typeof fetch = async () => {
      throw new Error(
        "ECONNRESET https://www.georisques.gouv.fr/api/v1/tri_zonage?latlon=0.689,47.399",
      );
    };
    let message = "";
    try {
      await runSaleFloodRiskBatch({
        now: NOW,
        api: { fetcher, pace: async () => undefined },
        communeCache: new Map(),
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("network");
    expect(message).not.toMatch(/georisques|47\.399|0\.689|secret-sale-id/);
  });

  it("une erreur d'écriture de la base ne lève que son code", async () => {
    db.sales = [sale("a")];
    db.writeError = { code: "23514", message: "check constraint violated (47.399,0.689)" };
    await expect(run(makeApi())).rejects.toThrow(/code 23514/);
    await expect(run(makeApi())).rejects.not.toThrow(/47\.399/);
  });
});

describe("runSaleFloodRiskBatch : cadence et file", () => {
  it("applique la cadence de 2 à 3 appels par seconde avant chaque appel externe", async () => {
    expect(FLOOD_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(334);
    expect(FLOOD_MIN_INTERVAL_MS).toBeLessThanOrEqual(500);
    db.sales = [sale("a")];
    let paced = 0;
    const api = makeApi();
    await runSaleFloodRiskBatch({
      now: NOW,
      api: {
        fetcher: api.fetcher,
        pace: async () => {
          paced += 1;
        },
      },
      communeCache: new Map(),
    });
    // Le point de contrôle, une requête TRI et une requête PPRi : tous services confondus.
    expect(paced).toBe(3);
    expect(api.calls).toHaveLength(2);
  });

  it("respecte la limite de la passe et rend le reste", async () => {
    db.sales = ["a", "b", "c", "d"].map((id) => sale(id));
    const result = await run(makeApi(), { limit: 2 });
    expect(result).toMatchObject({ pending: 4, observed: 2, remaining: 2 });
  });

  it("respecte le temps imparti : s'arrête avant une nouvelle vente", async () => {
    db.sales = ["a", "b"].map((id) => sale(id));
    const result = await run(makeApi(), { timeBudgetMs: -1 });
    expect(result).toMatchObject({ observed: 0, remaining: 2 });
  });

  it("une vente à jour n'est pas réobservée", async () => {
    db.sales = [sale("a")];
    db.floodRows = [
      {
        sale_id: "a",
        verdict: "none_found",
        derive_version: FLOOD_DERIVE_VERSION,
        position_key: floodPositionKey({
          latitude: TOURS.lat,
          longitude: TOURS.lon,
          precision: "address",
          flags: [],
          communeInsee: null,
        }),
        commune_insee: null,
        observed_at: daysAgo(10),
        attempted_at: daysAgo(10),
        failure_count: 0,
        ppri_checked: true,
        map_date: null,
        verdict_changed_at: daysAgo(10),
      },
    ];
    const api = makeApi();
    const result = await run(api);
    expect(result).toMatchObject({ pending: 0, observed: 0 });
    expect(api.calls).toHaveLength(0);
  });

  it("un changement de verdict date la ligne ; un verdict identique garde sa date de changement", async () => {
    db.sales = [sale("a")];
    const key = floodPositionKey({
      latitude: TOURS.lat,
      longitude: TOURS.lon,
      precision: "address",
      flags: [],
      communeInsee: null,
    });
    db.floodRows = [
      {
        sale_id: "a",
        verdict: "none_found",
        derive_version: FLOOD_DERIVE_VERSION,
        position_key: key,
        commune_insee: null,
        observed_at: daysAgo(100),
        attempted_at: daysAgo(100),
        failure_count: 0,
        ppri_checked: true,
        map_date: null,
        verdict_changed_at: daysAgo(100),
      },
    ];
    await run(makeApi());
    expect(written()[0].verdict_changed_at).toBe(daysAgo(100));

    db.upserts = [];
    await run(makeApi({ scenarios: ["01For"] }));
    expect(written()[0]).toMatchObject({ verdict: "high", verdict_changed_at: NOW.toISOString() });
  });
});

describe("runSaleFloodRiskBatch : avant les migrations", () => {
  it("sans la table des verdicts : se termine sans appel externe", async () => {
    db.sales = [sale("a")];
    db.floodRows = null;
    const api = makeApi();
    expect(await run(api)).toMatchObject({ skipped: "not_migrated", observed: 0 });
    expect(api.calls).toHaveLength(0);
  });

  it("sans la table des communes : même réponse", async () => {
    db.sales = [sale("a")];
    db.communeRows = null;
    const api = makeApi();
    expect(await run(api)).toMatchObject({ skipped: "not_migrated" });
    expect(api.calls).toHaveLength(0);
  });
});

describe("runSaleFloodRiskBatch : code commune du pipeline", () => {
  it("recopie raw_payload.commune dans la table des communes, puis s'en sert dans la même passe", async () => {
    db.sales = [sale("a", { location_precision: "municipality" })];
    // La recopie se fait dans la base (`sync_sale_communes()`, migration 20261108110100) : la passe l'appelle une
    // fois et en reporte le compte, sans relire `raw_payload`.
    db.syncCommunes = { n_with_code: 1, n_changed: 1, n_written: 1 };
    const api = makeApi();
    const result = await run(api);
    expect(result.communesWritten).toBe(1);
    expect(result.communesRejected).toBe(0);
    expect(db.rpcCalls.filter((call) => call.name === "sync_sale_communes")).toHaveLength(1);
    expect(db.tables).not.toContain("auction_sales");
  });

  it("lit les ventes à venir par curseur sur l'identifiant, filtrées par statut dans la base", async () => {
    db.sales = [
      ...Array.from({ length: 1500 }, (_, index) => sale(`s${String(index).padStart(5, "0")}`)),
      sale("past-sale", { status: "past" }),
    ];
    await run(makeApi());
    expect(db.salesReads).toHaveLength(2);
    expect(db.salesReads.every((read) => read.filters.status === "upcoming")).toBe(true);
    expect(db.salesReads[0].after).toBeNull();
    expect(db.salesReads[1].after).toBe("s00999");
  });
});

describe("pickFloodPending", () => {
  const key = floodPositionKey({
    latitude: TOURS.lat,
    longitude: TOURS.lon,
    precision: "address",
    flags: [],
    communeInsee: null,
  });
  const storedRow = (saleId: string, overrides: Record<string, unknown> = {}) => ({
    saleId,
    verdict: "none_found",
    deriveVersion: FLOOD_DERIVE_VERSION,
    positionKey: key,
    communeInsee: null,
    observedAt: daysAgo(10),
    attemptedAt: daysAgo(10),
    failureCount: 0,
    ppriChecked: true,
    mapDate: null,
    verdictChangedAt: daysAgo(10),
    ...overrides,
  });
  const flood = (id: string, overrides: Row = {}) => ({
    id,
    updatedAt: null,
    status: "upcoming",
    saleDate: FUTURE,
    latitude: TOURS.lat,
    longitude: TOURS.lon,
    locationPrecision: "address",
    qualityFlags: [] as string[],
    ...overrides,
  });

  it("ordonne : jamais observées, position modifiée, nouvel essai, autre version, plus anciennes", () => {
    const sales = ["aged", "version", "retry", "moved", "missing"].map((id) => flood(id));
    const stored = new Map([
      ["aged", storedRow("aged", { observedAt: daysAgo(120) })],
      ["version", storedRow("version", { deriveVersion: "flood-v0" })],
      ["retry", storedRow("retry", { failureCount: 2, attemptedAt: daysAgo(1) })],
      ["moved", storedRow("moved", { positionKey: "point:address:other" })],
    ]);
    const order = pickFloodPending(sales as never, stored as never, new Map(), NOW).map(
      (item) => item.sale.id,
    );
    expect(order).toEqual(["missing", "moved", "retry", "version", "aged"]);
  });
});

const ADDRESS_KEY = floodPositionKey({
  latitude: TOURS.lat,
  longitude: TOURS.lon,
  precision: "address",
  flags: [],
  communeInsee: null,
});

/** Une ligne stockée pour la position de `sale()`, observée il y a 100 jours (donc à rafraîchir). */
function storedFlood(saleId: string, overrides: Row = {}): Row {
  return {
    sale_id: saleId,
    verdict: "none_found",
    derive_version: FLOOD_DERIVE_VERSION,
    position_key: ADDRESS_KEY,
    commune_insee: null,
    observed_at: daysAgo(100),
    attempted_at: daysAgo(100),
    failure_count: 0,
    ppri_checked: true,
    map_date: null,
    verdict_changed_at: daysAgo(100),
    ...overrides,
  };
}

describe("runSaleFloodRiskBatch : périmètre des PPRi illisible", () => {
  it("n'écrase jamais un verdict « exposé » connu : seule la tentative est consignée", async () => {
    db.sales = [sale("a")];
    db.floodRows = [storedFlood("a", { verdict: "exposed", failure_count: 1 })];

    // PPRI illisible partout : aucune observation n'aboutit, la passe est déclarée en échec.
    await expect(run(makeApi({ ppri: "fail" }))).rejects.toThrow(/ppri_unreadable/);

    expect(written()).toEqual([]);
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].saleId).toBe("a");
    expect(db.updates[0].changes).toMatchObject({
      attempted_at: NOW.toISOString(),
      failure_count: 2,
      last_failure: "ppri_unreadable",
    });
    // Le verdict, sa date et son contrôle de PPRi ne sont pas dans la mise à jour.
    expect(Object.keys(db.updates[0].changes)).not.toEqual(
      expect.arrayContaining(["verdict", "ppri_checked", "observed_at"]),
    );
  });

  it("n'écrase pas non plus un « aucun risque élevé » lu en entier par un demi-contrôle", async () => {
    db.sales = [sale("a")];
    db.floodRows = [storedFlood("a")];
    await expect(run(makeApi({ ppri: "fail" }))).rejects.toThrow(/ppri_unreadable/);
    expect(written()).toEqual([]);
    expect(db.updates[0].changes).toMatchObject({ last_failure: "ppri_unreadable" });
  });

  it("un « exposé » est tout de même remplacé quand le périmètre est lu (sortie du périmètre)", async () => {
    db.sales = [sale("a")];
    db.floodRows = [storedFlood("a", { verdict: "exposed" })];
    await run(makeApi({ ppri: "out" }));
    expect(written()[0]).toMatchObject({ verdict: "none_found", ppri_checked: true });
    expect(db.updates).toEqual([]);
  });

  it("un « exposé » trouvé reste exposé même si un autre point du tampon est illisible", async () => {
    db.sales = [sale("a", { location_precision: "street" })];
    db.floodRows = [
      storedFlood("a", {
        verdict: "exposed",
        position_key: floodPositionKey({
          latitude: TOURS.lat,
          longitude: TOURS.lon,
          precision: "street",
          flags: [],
          communeInsee: null,
        }),
      }),
    ];
    let pm1 = 0;
    const api = makeApi({ ppri: "in" });
    const base = api.fetcher;
    api.fetcher = async (input, init) => {
      if (String(input).includes("generateur-sup-s") && (pm1 += 1) === 3) {
        return new Response("{}", { status: 503 });
      }
      return base(input, init);
    };
    await run(api);
    expect(written()[0]).toMatchObject({ verdict: "exposed", ppri_checked: false });
  });

  it("un changement de position remplace le verdict, même sans lecture du périmètre", async () => {
    db.sales = [sale("a")];
    db.floodRows = [storedFlood("a", { verdict: "exposed", position_key: "point:address:other" })];
    const result = await run(makeApi({ ppri: "fail" }));
    expect(result.observed).toBe(1);
    expect(written()[0]).toMatchObject({
      verdict: "none_found",
      ppri_checked: false,
      position_key: ADDRESS_KEY,
    });
  });

  it("un demi-contrôle déjà stocké peut être renouvelé par un demi-contrôle (nouvel essai plus tard)", async () => {
    db.sales = [sale("a")];
    db.floodRows = [
      storedFlood("a", { ppri_checked: false, attempted_at: daysAgo(1), observed_at: daysAgo(1) }),
    ];
    const result = await run(makeApi({ ppri: "fail" }));
    expect(result.observed).toBe(1);
    expect(written()[0]).toMatchObject({ verdict: "none_found", ppri_checked: false });
  });

  it("un changement du drapeau « périmètre lu » date de nouveau la ligne (la fiche change de texte)", async () => {
    db.sales = [sale("a")];
    db.floodRows = [
      storedFlood("a", { ppri_checked: false, attempted_at: daysAgo(1), observed_at: daysAgo(1) }),
    ];
    await run(makeApi({ ppri: "out" }));
    expect(written()[0]).toMatchObject({
      verdict: "none_found",
      ppri_checked: true,
      verdict_changed_at: NOW.toISOString(),
    });
  });
});

describe("runSaleFloodRiskBatch : temps imparti", () => {
  afterEach(() => vi.useRealTimers());

  it("laisse 40 s de marge sur les 300 s de la route", () => {
    expect(FLOOD_MAX_DURATION_MS).toBe(300_000);
    expect(FLOOD_MIN_REMAINING_MS).toBe(40_000);
    expect(FLOOD_DEFAULT_TIME_BUDGET_MS).toBe(260_000);
    expect(FLOOD_CALL_TIMEOUT_MS).toBe(8_000);
  });

  it("source lente, horloge simulée : aucune sonde ne démarre passé l'échéance, ce qui est fini est écrit", async () => {
    db.sales = [sale("a"), sale("b", { location_precision: "street" })];
    let clock = 0;
    const api = makeApi();
    const base = api.fetcher;
    api.fetcher = async (input, init) => {
      clock += 20_000; // chaque appel dure 20 s
      return base(input, init);
    };

    const result = await run(api, { timeBudgetMs: 100_000, clock: () => clock });

    // « a » : une sonde (2 appels, 40 s). « b » (rue) : deux sondes (4 appels), puis l'échéance (120 s > 100 s)
    // empêche la troisième ; « b » n'est pas finie, rien n'est écrit pour elle.
    expect(api.calls).toHaveLength(6);
    expect(result).toMatchObject({
      stoppedByDeadline: true,
      observed: 1,
      remaining: 1,
      skipped: null,
    });
    expect(written().map((row) => row.sale_id)).toEqual(["a"]);
  });

  it("l'échéance est aussi contrôlée avant l'appel de commune", async () => {
    db.sales = [sale("a", { location_precision: "municipality" })];
    db.communeRows = [COMMUNE("a")];
    const api = makeApi({ communeHasTri: true });
    const result = await run(api, {
      timeBudgetMs: 10,
      clock: (() => {
        let now = 0;
        return () => (now += 6);
      })(),
    });
    // 1er contrôle (avant la vente) : 6 ms ; 2e (avant l'appel de commune) : 12 ms > 10 ms.
    expect(api.calls).toHaveLength(0);
    expect(result.stoppedByDeadline).toBe(true);
    expect(written()).toEqual([]);
  });

  it("un appel TRI qui ne répond pas est coupé à 8 s (échec « timeout », verdict connu conservé)", async () => {
    vi.useFakeTimers();
    db.sales = [sale("a")];
    db.floodRows = [storedFlood("a", { verdict: "exposed" })];
    const fetcher: typeof fetch = (input, init) =>
      isControlUrl(String(input))
        ? Promise.resolve(controlAnswer())
        : new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          });
    const settled = runSaleFloodRiskBatch({
      now: NOW,
      api: { fetcher, pace: async () => undefined },
      communeCache: new Map(),
    }).then(
      () => null,
      (error: Error) => error,
    );

    await vi.advanceTimersByTimeAsync(FLOOD_CALL_TIMEOUT_MS);
    const error = await settled;

    expect(error?.message).toMatch(/timeout/);
    expect(db.updates[0].changes).toMatchObject({ last_failure: "timeout" });
    expect(written()).toEqual([]);
  });

  it("un périmètre PPRi qui ne répond pas est coupé à 8 s : verdict écrit sans lecture du périmètre", async () => {
    vi.useFakeTimers();
    db.sales = [sale("a")];
    const api = makeApi();
    const base = api.fetcher;
    const fetcher: typeof fetch = (input, init) =>
      String(input).includes("generateur-sup-s")
        ? new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          })
        : base(input, init);
    const settled = runSaleFloodRiskBatch({
      now: NOW,
      api: { fetcher, pace: async () => undefined },
      communeCache: new Map(),
    });

    await vi.advanceTimersByTimeAsync(FLOOD_CALL_TIMEOUT_MS);
    const result = await settled;

    expect(result.observed).toBe(1);
    expect(written()[0]).toMatchObject({ verdict: "none_found", ppri_checked: false });
  });
});

describe("runSaleFloodRiskBatch : écriture par paquets", () => {
  it("écrit tous les 25 ventes pendant la passe, non à la fin", async () => {
    expect(WRITE_CHUNK).toBe(25);
    const ids = Array.from({ length: 60 }, (_, index) => `s${String(index).padStart(2, "0")}`);
    db.sales = ids.map((id) => sale(id));
    const api = makeApi();
    const base = api.fetcher;
    const writtenAtSale: number[] = [];
    api.fetcher = async (input, init) => {
      if (String(input).includes("tri_zonage") && !isControlUrl(String(input))) {
        writtenAtSale.push(written().length);
      }
      return base(input, init);
    };

    const result = await run(api, { limit: 60 });

    expect(result.observed).toBe(60);
    // Avant la vente n° 26, le premier paquet de 25 est déjà écrit ; avant la n° 51, le deuxième aussi.
    expect(writtenAtSale[24]).toBe(0);
    expect(writtenAtSale[25]).toBe(25);
    expect(writtenAtSale[49]).toBe(25);
    expect(writtenAtSale[50]).toBe(50);
    const batches = db.upserts
      .filter((upsert) => upsert.table === "auction_sale_flood_risk")
      .map((upsert) => upsert.rows.length);
    expect(batches).toEqual([25, 25, 10]);
  });

  it("un arrêt anticipé (429) écrit quand même les verdicts déjà obtenus", async () => {
    db.sales = ["a", "b", "c"].map((id) => sale(id));
    let tri = 0;
    const api = makeApi();
    const base = api.fetcher;
    api.fetcher = async (input, init) =>
      String(input).includes("tri_zonage") && !isControlUrl(String(input)) && (tri += 1) === 3
        ? new Response("{}", { status: 429 })
        : base(input, init);
    const result = await run(api);
    expect(result).toMatchObject({ rateLimited: true, observed: 2 });
    expect(written().map((row) => row.sale_id)).toEqual(["a", "b"]);
  });
});

describe("runSaleFloodRiskBatch : ventes verrouillées par la publication du pipeline", () => {
  // Incident du 27/10/2026, 6 h 25 UTC : la publication du pipeline tenait des ventes FOR UPDATE ; l'écriture d'un
  // paquet a attendu le verrou jusqu'au délai de la requête (57014) et toute la passe a échoué.
  const sales = (count: number) =>
    Array.from({ length: count }, (_, index) => sale(`s${String(index).padStart(3, "0")}`));

  it("un paquet bloqué est réessayé en fin de passe : tout est écrit, la passe réussit", async () => {
    db.sales = sales(WRITE_CHUNK + 3);
    // Premier paquet bloqué, reliquat écrit, dernier essai du premier paquet écrit.
    db.busyFloodUpserts = [true, false, false];

    const result = await run(makeApi());

    expect(result.errors).toEqual([]);
    expect(new Set(written().map((row) => row.sale_id)).size).toBe(WRITE_CHUNK + 3);
  });

  it("encore bloqué au dernier essai : le reste est écrit, la passe réussit avec un avertissement", async () => {
    db.sales = sales(WRITE_CHUNK + 3);
    db.busyFloodUpserts = [true, false, true];

    const result = await run(makeApi());

    expect(result.errors).toEqual([`write_busy_${WRITE_CHUNK}`]);
    // Chiffré dans le résumé (alerte `flood_risk.write_blocked`), pas seulement dans les erreurs.
    expect(result.writeBusy).toBe(WRITE_CHUNK);
    // Les ventes non écrites restent sans verdict : la passe suivante les reprend.
    expect(written()).toHaveLength(3);
  });

  it("toutes les écritures bloquées : la passe échoue pour que la supervision le voie", async () => {
    db.sales = sales(3);
    db.busyFloodUpserts = [true, true];

    await expect(run(makeApi())).rejects.toThrow(/ventes verrouillées pendant toute la passe/);
    expect(written()).toEqual([]);
  });

  it("une autre erreur d'écriture que le verrou fait toujours échouer la passe", async () => {
    db.sales = sales(3);
    db.writeError = { code: "23514", message: "check" };

    await expect(run(makeApi())).rejects.toThrow(/code 23514/);
  });
});

describe("runSaleFloodRiskBatch : une seule passe à la fois", () => {
  it("rend le bail à la fin de la passe", async () => {
    db.sales = [sale("a")];
    await run(makeApi());
    expect(db.rpcCalls.map((call) => call.name)).toEqual([
      "claim_sale_flood_risk_lease",
      "sync_sale_communes",
      "release_sale_flood_risk_lease",
    ]);
    expect(db.rpcCalls[0].args).toEqual({ p_ttl_seconds: 360 });
    expect(db.rpcCalls[2].args).toEqual({ p_token: "lease-token" });
  });

  it("une seconde passe simultanée rend « busy » sans rien lire, appeler ni rendre", async () => {
    db.sales = [sale("a")];
    db.leaseHeld = true;
    const api = makeApi();

    const result = await run(api);

    expect(result).toMatchObject({ skipped: "busy", observed: 0, pending: 0 });
    expect(api.calls).toHaveLength(0);
    expect(db.tables).toEqual([]);
    expect(db.rpcCalls.map((call) => call.name)).toEqual(["claim_sale_flood_risk_lease"]);
  });

  it("rend le bail même quand la passe échoue", async () => {
    db.sales = [sale("a")];
    await expect(run(makeApi({ triStatus: 503 }))).rejects.toThrow();
    expect(db.rpcCalls.map((call) => call.name)).toEqual([
      "claim_sale_flood_risk_lease",
      "sync_sale_communes",
      "release_sale_flood_risk_lease",
    ]);
  });

  it("bail pas encore migré : la passe continue sans verrou (ordre de déploiement tolérant)", async () => {
    db.sales = [sale("a")];
    db.leaseHeld = "missing";
    const result = await run(makeApi());
    expect(result.observed).toBe(1);
    expect(db.rpcCalls.map((call) => call.name)).toEqual([
      "claim_sale_flood_risk_lease",
      "sync_sale_communes",
    ]);
  });
});

describe("runSaleFloodRiskBatch : erreurs d'écriture consignées", () => {
  it("l'échec d'une mise à jour de tentative laisse un code dans les erreurs, sans arrêter la passe", async () => {
    db.sales = [sale("new"), sale("known")];
    db.floodRows = [storedFlood("known", { verdict: "exposed" })];
    db.updateError = { code: "42501", message: "permission denied for table x" };
    const api = makeApi();
    const base = api.fetcher;
    let tri = 0;
    // Les ventes jamais observées passent d'abord : « new » est observée, puis « known » échoue côté source et la
    // mise à jour de sa tentative est refusée par la base.
    api.fetcher = async (input, init) =>
      String(input).includes("tri_zonage") && !isControlUrl(String(input)) && (tri += 1) === 2
        ? new Response("{}", { status: 503 })
        : base(input, init);

    const result = await run(api);

    expect(result.observed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors).toEqual(["http_503", "attempt_write_42501"]);
    expect(written().map((row) => row.sale_id)).toEqual(["new"]);
    expect(JSON.stringify(result)).not.toContain("permission denied");
  });
});

/** Un fetcher qui répond à chaque appel de vente selon son rang (le point de contrôle est servi à part). */
function scriptedApi(answer: (rank: number) => Response | Error) {
  const api = makeApi();
  const base = api.fetcher;
  let rank = 0;
  api.fetcher = async (input, init) => {
    const url = String(input);
    if (isControlUrl(url) || !url.includes("tri_zonage")) return base(input, init);
    const outcome = answer(rank);
    rank += 1;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return Object.assign(api, { triCalls: () => rank });
}
const emptyTri = () =>
  new Response(JSON.stringify({ results: 0, data: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const reset = () =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  });
const manySales = (count: number) =>
  Array.from({ length: count }, (_, index) => sale(`m${String(index).padStart(3, "0")}`));

describe("runSaleFloodRiskBatch : passe dégradée (pannes partielles)", () => {
  it("la moitié des appels échouent sur au moins 20 appels : la passe échoue, avec les codes chiffrés", async () => {
    db.sales = manySales(40);
    // 20 réussites, 20 échecs 503 en alternance : 50 % exactement.
    const api = scriptedApi((rank) =>
      rank % 2 === 0 ? new Response("{}", { status: 503 }) : emptyTri(),
    );

    await expect(run(api)).rejects.toThrow(
      /dégradée : 20 appel\(s\) en échec sur 40 \(seuil 50 %\), par code http_503=20/,
    );
    // Ce qui a pu être observé est écrit malgré tout : les 20 verdicts et les 20 tentatives.
    expect(written().filter((row) => row.verdict === "none_found")).toHaveLength(20);
    expect(written().filter((row) => row.last_failure === "http_503")).toHaveLength(20);
  });

  it("moins de la moitié d'échecs, ou moins de 20 appels : la passe réussit et chiffre les échecs", async () => {
    db.sales = manySales(40);
    const mostlyFine = scriptedApi((rank) =>
      rank % 8 === 0 ? new Response("{}", { status: 503 }) : emptyTri(),
    );
    const result = await run(mostlyFine);
    expect(result).toMatchObject({
      observed: 35,
      failed: 5,
      callsObserved: 35,
      callsFailed: 5,
      failedByCode: { http_503: 5 },
      circuitOpen: false,
    });

    db.upserts = [];
    db.sales = manySales(10);
    const fewCalls = scriptedApi((rank) =>
      rank < 6 ? new Response("{}", { status: 503 }) : emptyTri(),
    );
    const small = await run(fewCalls);
    expect(small).toMatchObject({ observed: 4, failed: 6, failedByCode: { http_503: 6 } });
  });

  it("le nombre de ventes à venir en attente de réobservation est dans le résultat", async () => {
    // « k » a une tentative en échec d'hier (non reprise avant plusieurs heures) ; « b » échouera dans la passe.
    db.sales = [
      sale("k"),
      sale("b", { sale_date: "2026-12-21T10:00:00.000Z" }),
      sale("c", { sale_date: "2026-12-22T10:00:00.000Z" }),
    ];
    db.floodRows = [
      storedFlood("k", {
        failure_count: 2,
        observed_at: daysAgo(1),
        attempted_at: NOW.toISOString(),
      }),
    ];
    const result = await run(
      scriptedApi((rank) => (rank === 0 ? new Response("{}", { status: 503 }) : emptyTri())),
    );
    expect(result.awaitingReobservation).toBe(2);

    // Une vente réobservée avec succès sort du compteur.
    db.sales = [sale("k")];
    db.floodRows = [storedFlood("k", { failure_count: 2, attempted_at: daysAgo(1) })];
    const recovered = await run(makeApi());
    expect(recovered).toMatchObject({ observed: 1, awaitingReobservation: 0 });

    // Une vente passée n'est pas comptée.
    db.sales = [sale("old", { status: "past" })];
    db.floodRows = [storedFlood("old", { failure_count: 3 })];
    expect((await run(makeApi())).awaitingReobservation).toBe(0);
  });
});

describe("runSaleFloodRiskBatch : coupe-circuit des pannes réseau", () => {
  it("s'arrête après 5 pannes réseau de suite : plus aucun appel, le reste est repris à la passe suivante", async () => {
    db.sales = manySales(12);
    const api = scriptedApi((rank) => (rank < 3 ? emptyTri() : reset()));

    const result = await run(api);

    expect(result).toMatchObject({
      circuitOpen: true,
      observed: 3,
      failed: 5,
      failedByCode: { network_econnreset: 5 },
      remaining: 4,
    });
    // 3 réussites puis 5 pannes : la sixième n'est jamais appelée.
    expect(api.triCalls()).toBe(8);
  });

  it("une réussite remet le compte à zéro : des pannes isolées n'ouvrent pas le circuit", async () => {
    db.sales = manySales(18);
    // 4 pannes, 1 réussite, 4 pannes, 1 réussite, 4 pannes, 1 réussite, 3 pannes.
    const api = scriptedApi((rank) => (rank % 5 === 4 ? emptyTri() : reset()));
    const result = await run(api).catch((error: Error) => error);
    // 18 appels : moins de 20, donc pas de passe dégradée ; le circuit n'est jamais ouvert.
    expect(result).toMatchObject({ circuitOpen: false, failed: 15, observed: 3 });
  });

  it("une panne autre que réseau (503) ne l'ouvre pas", async () => {
    db.sales = manySales(8);
    const api = scriptedApi((rank) =>
      rank === 0 ? emptyTri() : new Response("{}", { status: 503 }),
    );
    const result = await run(api);
    expect(result).toMatchObject({ circuitOpen: false, failed: 7, observed: 1 });
  });
});

describe("runSaleFloodRiskBatch : point de contrôle de la source", () => {
  it("une seule fois par passe, avant le premier appel de position", async () => {
    db.sales = manySales(60);
    const api = makeApi();
    await run(api);
    expect(api.controlCalls).toHaveLength(1);
    expect(new URL(api.controlCalls[0]).searchParams.get("latlon")).toBe(CONTROL_LATLON);
  });

  it("une réponse vide au point de contrôle : source_degraded, rien n'est écrit, aucune vente n'est appelée", async () => {
    db.sales = manySales(3);
    const api = makeApi({ controlScenarios: [] });
    await expect(run(api)).rejects.toThrow(/\(source_degraded\).*\(no_scenario\)/);
    expect(written()).toEqual([]);
    expect(db.updates).toEqual([]);
    expect(api.calls).toEqual([]);
  });

  it("une réponse autre que 01For au point de contrôle est aussi refusée", async () => {
    db.sales = manySales(2);
    await expect(run(makeApi({ controlScenarios: ["04Fai"] }))).rejects.toThrow(/source_degraded/);
  });

  it("un point de contrôle en panne (503, 403) : source_degraded avec le code, sans coordonnée", async () => {
    db.sales = manySales(2);
    const error = await run(makeApi({ controlStatus: 403 })).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/source_degraded.*http_403/);
    expect((error as Error).message).not.toMatch(/43\.6026|1\.4314/);
    expect(written()).toEqual([]);
  });

  it("un 429 au point de contrôle arrête la passe comme tout 429", async () => {
    db.sales = manySales(2);
    const api = makeApi({ controlStatus: 429 });
    await expect(run(api)).rejects.toThrow(/limite de débit \(429\)/);
    expect(api.calls).toEqual([]);
  });

  it("des ventes à position approximative seulement : aucun appel de position, donc pas de contrôle", async () => {
    db.sales = [sale("a", { location_precision: null, latitude: null, longitude: null })];
    db.communeRows = [COMMUNE("a")];
    const api = makeApi({ controlScenarios: [] });
    const result = await run(api);
    expect(result.observed).toBe(1);
    expect(api.controlCalls).toEqual([]);
  });
});

describe("runSaleFloodRiskBatch : une ligne refusée par la base ne bloque pas le paquet", () => {
  it("la ligne fautive est isolée en coupant le paquet par moitiés : les 24 autres sont écrites", async () => {
    db.sales = manySales(WRITE_CHUNK);
    db.rejectedSaleIds = ["m007"];

    const result = await run(makeApi());

    expect(result).toMatchObject({ observed: WRITE_CHUNK, writeRejected: 1 });
    expect(result.errors).toEqual(["write_refused_22008"]);
    expect(written()).toHaveLength(WRITE_CHUNK - 1);
    expect(written().map((row) => row.sale_id)).not.toContain("m007");
  });

  it("plus de 5 lignes refusées : la panne n'est plus isolée, la passe échoue", async () => {
    db.sales = manySales(WRITE_CHUNK);
    db.rejectedSaleIds = manySales(8).map((item) => String(item.id));
    await expect(run(makeApi())).rejects.toThrow(/code 22008/);
  });

  it("toutes les lignes refusées : la passe échoue pour que la supervision le voie", async () => {
    db.sales = manySales(3);
    db.rejectedSaleIds = ["m000", "m001", "m002"];
    await expect(run(makeApi())).rejects.toThrow(/3 ligne\(s\) refusée\(s\) \(code 22008\)/);
  });
});
