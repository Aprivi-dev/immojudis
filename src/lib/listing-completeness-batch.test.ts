import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  online: [] as Row[],
  stored: [] as Row[],
  fullRows: new Map<string, Row>(),
  scores: new Map<string, number>(),
  upserts: [] as Row[][],
  upsertError: null as { message: string } | null,
  readError: null as { message: string } | null,
  fullReads: [] as string[][],
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => new FakeQuery(table),
  },
}));
vi.mock("@/lib/listing-completeness", () => ({
  getListingCompleteness: (sale: { id: string }) => {
    const score = db.scores.get(sale.id);
    if (score === undefined) throw new Error(`boom ${sale.id}`);
    // La classification publiée n'intervient plus dans le palier: elle est rendue pour prouver
    // que le palier ne la lit pas (ici toujours « incomplet », même avec un score élevé).
    return { score, classification: "incomplet" };
  },
}));
vi.mock("@/lib/listing-data-cleanup", () => ({
  sanitizeAuctionSaleForDisplay: (sale: unknown) => sale,
}));

import {
  evaluateListing,
  pickPendingSales,
  runListingCompletenessBatch,
} from "./listing-completeness-batch";
import { LISTING_COMPLETENESS_POLICY } from "./listing-completeness-ranking";

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private ids: string[] | null = null;
  private page: [number, number] = [0, 999];
  private upsertRows: Row[] | null = null;

  constructor(private readonly table: string) {}

  select() {
    return this;
  }
  order() {
    return this;
  }
  range(from: number, to: number) {
    this.page = [from, to];
    return this;
  }
  in(_column: string, ids: string[]) {
    this.ids = ids;
    return this;
  }
  upsert(rows: Row[]) {
    this.upsertRows = rows;
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
    if (this.upsertRows) {
      if (db.upsertError) return { data: null, error: db.upsertError };
      db.upserts.push(this.upsertRows);
      return { data: null, error: null };
    }
    if (this.table === "auction_sale_listing_completeness") {
      return { data: db.stored.slice(this.page[0], this.page[1] + 1), error: null };
    }
    if (this.ids) {
      if (db.readError) return { data: null, error: db.readError };
      db.fullReads.push(this.ids);
      return {
        data: this.ids.flatMap((id) => (db.fullRows.has(id) ? [db.fullRows.get(id)] : [])),
        error: null,
      };
    }
    return { data: db.online.slice(this.page[0], this.page[1] + 1), error: null };
  }
}

const NOW = new Date("2026-10-14T10:00:00.000Z");
const EVALUATED = "2026-10-14T08:00:00.000Z";
const BEFORE = "2026-10-14T07:00:00.000Z";
const AFTER = "2026-10-14T09:00:00.000Z";
const V1 = LISTING_COMPLETENESS_POLICY.version;

function stored(sale_id: string, evaluated_at = EVALUATED, policy_version = V1): Row {
  return { sale_id, evaluated_at, policy_version };
}

function setOnline(sales: Array<[string, string | null, number | undefined]>) {
  db.online = sales.map(([id, updated_at]) => ({ id, updated_at }));
  db.fullRows = new Map(sales.map(([id, updated_at]) => [id, { id, updated_at }]));
  db.scores = new Map(
    sales.flatMap(([id, , score]) => (score === undefined ? [] : [[id, score] as const])),
  );
}

beforeEach(() => {
  db.online = [];
  db.stored = [];
  db.fullRows = new Map();
  db.scores = new Map();
  db.upserts = [];
  db.upsertError = null;
  db.readError = null;
  db.fullReads = [];
});

describe("pickPendingSales", () => {
  const evaluation = (saleId: string, evaluatedAt = EVALUATED, policyVersion: string = V1) => ({
    saleId,
    evaluatedAt,
    policyVersion,
  });

  it("choisit les ventes sans évaluation, d'une autre version ou modifiées depuis", () => {
    const pending = pickPendingSales(
      [
        { id: "new", updatedAt: BEFORE },
        { id: "old-policy", updatedAt: BEFORE },
        { id: "modified", updatedAt: AFTER },
        { id: "up-to-date", updatedAt: BEFORE },
        { id: "no-date", updatedAt: null },
      ],
      [
        evaluation("old-policy", EVALUATED, "completeness-tier-v0"),
        evaluation("modified"),
        evaluation("up-to-date"),
        evaluation("no-date"),
        evaluation("offline-sale"),
      ],
      V1,
      NOW,
    );
    expect(pending).toEqual(["new", "old-policy", "modified"]);
  });

  it("traite d'abord les ventes jamais évaluées, les plus récemment modifiées en tête", () => {
    const pending = pickPendingSales(
      [
        { id: "b-modified", updatedAt: AFTER },
        { id: "a-old-policy", updatedAt: BEFORE },
        { id: "c-new-old", updatedAt: "2026-10-01T00:00:00.000Z" },
        { id: "d-new-recent", updatedAt: AFTER },
      ],
      [evaluation("b-modified"), evaluation("a-old-policy", EVALUATED, "other")],
      V1,
      NOW,
    );
    expect(pending).toEqual(["d-new-recent", "c-new-old", "a-old-policy", "b-modified"]);
  });

  it("réévalue tout quand la version de la règle change", () => {
    const sales = [
      { id: "a", updatedAt: BEFORE },
      { id: "b", updatedAt: BEFORE },
    ];
    const rows = [evaluation("a"), evaluation("b")];
    expect(pickPendingSales(sales, rows, V1, NOW)).toEqual([]);
    // Les ventes notées avec la règle v1 (classification « décision prête ») sont toutes refaites.
    const v1Rows = [
      evaluation("a", EVALUATED, "completeness-tier-v1"),
      evaluation("b", EVALUATED, "completeness-tier-v1"),
    ];
    expect(pickPendingSales(sales, v1Rows, V1, NOW)).toEqual(["a", "b"]);
    expect(pickPendingSales(sales, rows, "completeness-tier-v1", NOW)).toEqual(["a", "b"]);
    expect(pickPendingSales(sales, rows, "completeness-tier-v3", NOW)).toEqual(["a", "b"]);
  });

  it("réévalue au bout de 24 h une vente inchangée (tables liées), les plus anciennes d'abord", () => {
    const sales = [
      { id: "fresh", updatedAt: "2026-10-01T00:00:00.000Z" },
      { id: "day-old", updatedAt: "2026-10-01T00:00:00.000Z" },
      { id: "older", updatedAt: "2026-10-01T00:00:00.000Z" },
      { id: "just-under", updatedAt: "2026-10-01T00:00:00.000Z" },
    ];
    const rows = [
      evaluation("fresh", "2026-10-14T09:00:00.000Z"),
      evaluation("day-old", "2026-10-13T09:00:00.000Z"),
      evaluation("older", "2026-10-12T09:00:00.000Z"),
      evaluation("just-under", "2026-10-13T10:00:01.000Z"),
    ];
    expect(pickPendingSales(sales, rows, V1, NOW)).toEqual(["older", "day-old"]);
  });

  it("place les ventes modifiées avant celles qui sont simplement anciennes", () => {
    const rows = [
      evaluation("aged", "2026-10-10T09:00:00.000Z"),
      evaluation("modified", "2026-10-13T09:00:00.000Z"),
    ];
    const sales = [
      { id: "aged", updatedAt: "2026-10-01T00:00:00.000Z" },
      { id: "modified", updatedAt: "2026-10-14T00:00:00.000Z" },
    ];
    expect(pickPendingSales(sales, rows, V1, NOW)).toEqual(["modified", "aged"]);
  });
});

describe("evaluateListing", () => {
  it("tire le palier du score (seuil 40), avec version de la règle et empreinte", () => {
    db.scores.set("high", 71);
    db.scores.set("threshold", 40);
    db.scores.set("just-under", 39.9);
    db.scores.set("low", 20);
    const high = evaluateListing({ id: "high" } as never, NOW);
    expect(high).toMatchObject({
      sale_id: "high",
      score: 71,
      tier: 1,
      policy_version: "completeness-tier-v2",
      evaluated_at: NOW.toISOString(),
    });
    expect(high.input_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(evaluateListing({ id: "threshold" } as never, NOW).tier).toBe(1);
    expect(evaluateListing({ id: "just-under" } as never, NOW).tier).toBe(0);
    expect(evaluateListing({ id: "low" } as never, NOW).tier).toBe(0);
    expect(evaluateListing({ id: "high", extra: 1 } as never, NOW).input_fingerprint).not.toBe(
      high.input_fingerprint,
    );
  });

  it("décide sur le score arrondi à une décimale, celui qui est stocké", () => {
    db.scores.set("rounds-up", 39.96);
    db.scores.set("rounds-down", 39.94);
    expect(evaluateListing({ id: "rounds-up" } as never, NOW)).toMatchObject({
      score: 40,
      tier: 1,
    });
    expect(evaluateListing({ id: "rounds-down" } as never, NOW)).toMatchObject({
      score: 39.9,
      tier: 0,
    });
  });

  it("arrondit le score à une décimale", () => {
    db.scores.set("round", 82.34);
    db.scores.set("round-up", 82.36);
    expect(evaluateListing({ id: "round" } as never, NOW).score).toBe(82.3);
    expect(evaluateListing({ id: "round-up" } as never, NOW).score).toBe(82.4);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.1, 100.1, 250])(
    "refuse un score invalide (%s)",
    (score) => {
      db.scores.set("bad", score);
      expect(() => evaluateListing({ id: "bad" } as never, NOW)).toThrow(
        /Score de complétude invalide pour bad/,
      );
    },
  );
});

describe("runListingCompletenessBatch", () => {
  it("évalue les ventes en attente et enregistre le palier sans toucher aux autres", async () => {
    setOnline([
      ["new-high", BEFORE, 82],
      ["new-low", BEFORE, 39.9],
      ["modified", AFTER, 91.5],
      ["up-to-date", BEFORE, 99],
    ]);
    db.stored = [stored("modified"), stored("up-to-date")];

    const result = await runListingCompletenessBatch({ now: NOW });

    expect(result).toMatchObject({
      policyVersion: V1,
      online: 4,
      pending: 3,
      evaluated: 3,
      highTier: 2,
      failed: 0,
      remaining: 0,
      errors: [],
    });
    const rows = db.upserts.flat();
    expect(rows.map((row) => [row.sale_id, row.tier, row.score]).sort()).toEqual([
      ["modified", 1, 91.5],
      ["new-high", 1, 82],
      ["new-low", 0, 39.9],
    ]);
    expect(db.fullReads.flat()).not.toContain("up-to-date");
  });

  it("ne tient pas compte des portes critiques: le score seul décide du palier", async () => {
    setOnline([
      ["at-threshold", BEFORE, 40],
      ["under-threshold", BEFORE, 39.9],
    ]);

    const result = await runListingCompletenessBatch({ now: NOW });

    expect(result).toMatchObject({ evaluated: 2, highTier: 1 });
    expect(
      db.upserts
        .flat()
        .map((row) => [row.sale_id, row.tier, row.score])
        .sort(),
    ).toEqual([
      ["at-threshold", 1, 40],
      ["under-threshold", 0, 39.9],
    ]);
  });

  it("réévalue une vente évaluée il y a plus de 24 h", async () => {
    setOnline([["aged", "2026-10-01T00:00:00.000Z", 90]]);
    db.stored = [stored("aged", "2026-10-13T08:00:00.000Z")];

    const result = await runListingCompletenessBatch({ now: NOW });

    expect(result).toMatchObject({ pending: 1, evaluated: 1 });
  });

  it("respecte la taille du lot et indique ce qui reste", async () => {
    setOnline(Array.from({ length: 60 }, (_, index) => [`sale-${index}`, BEFORE, 80]));

    const result = await runListingCompletenessBatch({ limit: 30, now: NOW });

    expect(result).toMatchObject({ online: 60, pending: 60, evaluated: 30, remaining: 30 });
    expect(db.upserts.flat()).toHaveLength(30);
    // Les lectures de lignes complètes sont découpées en petits lots.
    expect(Math.max(...db.fullReads.map((ids) => ids.length))).toBeLessThanOrEqual(25);
  });

  it("s'arrête quand le temps imparti est écoulé, la prochaine exécution reprend", async () => {
    setOnline(Array.from({ length: 60 }, (_, index) => [`sale-${index}`, BEFORE, 80]));

    const result = await runListingCompletenessBatch({ now: NOW, timeBudgetMs: -1 });

    expect(result).toMatchObject({ evaluated: 0, failed: 0, remaining: 60 });
    expect(db.fullReads).toEqual([]);
  });

  it("signale une annonce dont le calcul échoue sans bloquer les autres", async () => {
    // Un échec isolé (moins de 20 % des évaluations tentées) ne fait pas échouer la passe.
    setOnline([
      ["broken", BEFORE, undefined],
      ...Array.from(
        { length: 9 },
        (_, index) => [`good-${index}`, BEFORE, 80] as [string, string, number],
      ),
    ]);

    const result = await runListingCompletenessBatch({ now: NOW });

    expect(result).toMatchObject({ evaluated: 9, failed: 1, remaining: 1 });
    expect(result.errors).toEqual(["boom broken"]);
    expect(db.upserts.flat().map((row) => row.sale_id)).not.toContain("broken");
    expect(db.upserts.flat()).toHaveLength(9);
  });

  it("saute une vente au score invalide sans faire échouer les autres de son paquet", async () => {
    setOnline([
      ["good-1", BEFORE, 80],
      ["nan", BEFORE, Number.NaN],
      ["too-high", BEFORE, 101],
      ["good-2", BEFORE, 30.04],
      ...Array.from(
        { length: 10 },
        (_, index) => [`more-${index}`, BEFORE, 60] as [string, string, number],
      ),
    ]);

    const result = await runListingCompletenessBatch({ now: NOW });

    // Deux échecs sur quatorze tentées (14 %) : sous le seuil de 20 %.
    expect(result).toMatchObject({ evaluated: 12, failed: 2, remaining: 2 });
    expect(result.errors.join(" ")).toContain("Score de complétude invalide pour");
    const scores = new Map(db.upserts.flat().map((row) => [row.sale_id, row.score]));
    expect(scores.get("good-1")).toBe(80);
    expect(scores.get("good-2")).toBe(30);
    expect(scores.has("nan")).toBe(false);
    expect(scores.has("too-high")).toBe(false);
  });

  it("échoue (tâche en erreur) quand 20 % des évaluations tentées ou plus ont échoué", async () => {
    // Une sur cinq : exactement le seuil.
    setOnline([
      ["broken", BEFORE, undefined],
      ...Array.from(
        { length: 4 },
        (_, index) => [`good-${index}`, BEFORE, 80] as [string, string, number],
      ),
    ]);

    await expect(runListingCompletenessBatch({ now: NOW })).rejects.toThrow(
      "Évaluation de complétude partielle : 1 échec(s) sur 5 évaluation(s) tentée(s) (seuil 20 %) : boom broken",
    );
    // Les évaluations réussies sont enregistrées malgré l'échec de la tâche.
    expect(db.upserts.flat()).toHaveLength(4);
  });

  it("échoue aussi quand la moitié des paquets lus échoue", async () => {
    setOnline([
      ["good-1", BEFORE, 80],
      ["good-2", BEFORE, 80],
      ["broken", BEFORE, undefined],
      ["nan", BEFORE, Number.NaN],
    ]);

    await expect(runListingCompletenessBatch({ now: NOW })).rejects.toThrow(
      /Évaluation de complétude partielle : 2 échec\(s\) sur 4/,
    );
  });

  it("échoue (tâche en erreur) quand rien ne peut être enregistré", async () => {
    setOnline([["a", BEFORE, 80]]);
    db.upsertError = { message: "permission denied" };
    await expect(runListingCompletenessBatch({ now: NOW })).rejects.toThrow(
      "Évaluation de complétude impossible : permission denied",
    );

    db.upsertError = null;
    db.readError = { message: "timeout" };
    await expect(runListingCompletenessBatch({ now: NOW })).rejects.toThrow(
      "Évaluation de complétude impossible : timeout",
    );
  });

  it("ne fait rien quand tout est à jour", async () => {
    setOnline([["a", BEFORE, 80]]);
    db.stored = [stored("a")];
    const result = await runListingCompletenessBatch({ now: NOW });
    expect(result).toMatchObject({ pending: 0, evaluated: 0, failed: 0, remaining: 0 });
    expect(db.upserts).toEqual([]);
  });
});
