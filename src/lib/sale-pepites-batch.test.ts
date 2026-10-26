import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PepiteEvaluation, PepiteInput } from "@/lib/pepite-policy";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  mode: "shadow" as string | null,
  modeError: null as { code?: string; message: string } | null,
  online: [] as Row[],
  stored: [] as Row[],
  storedError: null as { code?: string; message: string } | null,
  fullRows: new Map<string, Row>(),
  estimates: new Map<string, Row>(),
  upserts: [] as Row[][],
  upsertError: null as { code?: string; message: string } | null,
  readError: null as { message: string } | null,
  touched: [] as string[],
  fullReads: [] as string[][],
  evaluations: new Map<string, unknown>(),
  evaluateError: new Set<string>(),
  scenarioCalls: [] as string[],
  /** Ventes dont la ligne `auction_sales` (empreinte) est introuvable. */
  missingInputs: new Set<string>(),
  /** Ventes dont l'écriture est refusée par la base (contrainte), même seule. */
  upsertRejects: new Set<string>(),
  /** Ce que le calcul a reçu comme estimation, par vente. */
  estimateArgs: new Map<string, unknown>(),
  /** Règle de la dernière évaluation et verdict d'inondation reçu, par vente. */
  floodArgs: new Map<string, { flood: unknown; ruleVersion: unknown }>(),
  /** Verdicts d'inondation stockés ; `null` : la table n'existe pas (migration non appliquée). */
  floodRows: [] as Row[] | null,
  /** Codes commune des ventes ; `null` : la table n'existe pas. */
  communeRows: [] as Row[] | null,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => new FakeQuery(table),
    rpc: async (name: string) => {
      db.touched.push(`rpc:${name}`);
      if (db.modeError) return { data: null, error: db.modeError };
      return { data: db.mode, error: null };
    },
  },
}));
vi.mock("@/lib/fee-regime.server", () => ({
  openFeeRegimesFromEnv: () => ["tribunal", "notary_auction", "notary_online"],
}));
vi.mock("@/lib/auction-scenarios.server", () => ({
  getAuctionScenarios: async (sale: { id: string }) => {
    db.scenarioCalls.push(sale.id);
    return { scenarios: null };
  },
}));
vi.mock("@/lib/sale-market-estimates", () => ({
  SALE_INPUT_SELECT: "id,title",
  buildSaleValuationInput: (row: Row) => ({ saleId: row.id }),
  saleValuationFingerprint: () => "fingerprint",
  marketContextFromStoredRow: (row: Row | null, fingerprint?: string) => ({
    ok: row != null,
    error: null,
    estimate: row ? { fingerprint } : null,
  }),
}));
vi.mock("@/lib/pepite-input", () => ({
  evaluateSaleForPepite: (
    { sale, estimate, flood }: { sale: { id: string }; estimate?: unknown; flood?: unknown },
    ruleVersion?: unknown,
  ) => {
    db.estimateArgs.set(sale.id, estimate ?? null);
    db.floodArgs.set(sale.id, { flood, ruleVersion });
    if (db.evaluateError.has(sale.id)) throw new Error(`boom ${sale.id}`);
    const entry = db.evaluations.get(sale.id) as
      | { evaluation: PepiteEvaluation; input?: PepiteInput; facts: Row }
      | undefined;
    if (!entry) throw new Error(`pas d'évaluation prévue pour ${sale.id}`);
    // Comme la vraie fonction : les faits portent le verdict d'inondation sous la règle v2 seulement.
    return {
      ...entry,
      facts: { ...entry.facts, flood: ruleVersion === "pepite-v2" ? flood : null },
    };
  },
}));

import {
  buildNotApplicableRow,
  buildPepiteRow,
  currentPepiteVersions,
  isObsoleteEvaluation,
  isUpcomingSale,
  pepiteDetails,
  pickPendingSales,
  runSalePepitesBatch,
  storedStateFor,
  type OnlineSale,
  type StoredEvaluation,
} from "./sale-pepites-batch";
import { CEILING_ENGINE_VERSION } from "./bid-ceiling-engine";
import { FLOOD_DERIVE_VERSION } from "./flood-risk";
import { floodPositionKey } from "./flood-risk-position.server";
import { evaluatePepite } from "./pepite-policy";

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private ids: string[] | null = null;
  private page: [number, number] = [0, 999];
  private upsertRows: Row[] | null = null;
  private columns = "";

  constructor(private readonly table: string) {}

  select(columns: string) {
    this.columns = columns;
    return this;
  }
  order() {
    return this;
  }
  eq() {
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
    db.touched.push(this.table);
    if (this.upsertRows) {
      if (db.upsertError) return { data: null, error: db.upsertError };
      if (this.upsertRows.some((row) => db.upsertRejects.has(row.sale_id as string))) {
        return { data: null, error: { code: "23514", message: "check constraint (80000)" } };
      }
      db.upserts.push(this.upsertRows);
      return { data: null, error: null };
    }
    switch (this.table) {
      case "auction_sale_pepites":
        if (db.storedError) return { data: null, error: db.storedError };
        return { data: db.stored.slice(this.page[0], this.page[1] + 1), error: null };
      case "v_auction_sales_app":
        if (this.columns === "*") {
          if (db.readError) return { data: null, error: db.readError };
          db.fullReads.push(this.ids ?? []);
          return {
            data: (this.ids ?? []).flatMap((id) =>
              db.fullRows.has(id) ? [db.fullRows.get(id)] : [],
            ),
            error: null,
          };
        }
        return { data: db.online.slice(this.page[0], this.page[1] + 1), error: null };
      case "auction_sale_flood_risk":
        if (db.floodRows == null) {
          return { data: null, error: { code: "PGRST205", message: "Could not find the table" } };
        }
        return { data: db.floodRows.slice(this.page[0], this.page[1] + 1), error: null };
      case "auction_sale_communes":
        if (db.communeRows == null) {
          return { data: null, error: { code: "PGRST205", message: "Could not find the table" } };
        }
        return { data: db.communeRows.slice(this.page[0], this.page[1] + 1), error: null };
      case "auction_sales":
        return {
          data: (this.ids ?? [])
            .filter((id) => !db.missingInputs.has(id))
            .map((id) => ({ id, score_status: null })),
          error: null,
        };
      case "auction_sale_market_estimates":
        if (this.ids) {
          return {
            data: this.ids.flatMap((id) => (db.estimates.has(id) ? [db.estimates.get(id)] : [])),
            error: null,
          };
        }
        return {
          data: [...db.estimates.values()].slice(this.page[0], this.page[1] + 1),
          error: null,
        };
      default:
        return { data: [], error: null };
    }
  }
}

const NOW = new Date("2026-11-01T12:00:00.000Z");
const FUTURE = "2026-12-15T10:00:00.000Z";
const EVALUATED = "2026-11-01T08:00:00.000Z";
const BEFORE = "2026-11-01T07:00:00.000Z";
const AFTER = "2026-11-01T09:00:00.000Z";
const VERSIONS = currentPepiteVersions();

function stored(saleId: string, overrides: Partial<StoredEvaluation> = {}): StoredEvaluation {
  return {
    saleId,
    status: "not_pepite",
    evaluatedAt: EVALUATED,
    ruleVersion: VERSIONS.rule,
    engineVersion: CEILING_ENGINE_VERSION,
    regimeVersion: VERSIONS.regimes[0] ?? null,
    isPepite: false,
    favorableStreak: 0,
    frozenAt: null,
    lastFavorableAt: null,
    dataMissingSince: null,
    inputStartingPriceEur: 80_000,
    firstPepiteAt: null,
    ...overrides,
  };
}

function online(id: string, overrides: Partial<OnlineSale> = {}): OnlineSale {
  return {
    id,
    updatedAt: BEFORE,
    status: "upcoming",
    saleDate: FUTURE,
    venueType: "tribunal",
    startingPriceEur: 80_000,
    ...overrides,
  };
}

function storedRow(saleId: string, overrides: Partial<StoredEvaluation> = {}): Row {
  const row = stored(saleId, overrides);
  return {
    sale_id: row.saleId,
    status: row.status,
    last_favorable_at: row.lastFavorableAt,
    data_missing_since: row.dataMissingSince,
    evaluated_at: row.evaluatedAt,
    rule_version: row.ruleVersion,
    engine_version: row.engineVersion,
    regime_version: row.regimeVersion,
    is_pepite: row.isPepite,
    favorable_streak: row.favorableStreak,
    frozen_at: row.frozenAt,
    input_starting_price_eur: row.inputStartingPriceEur,
    first_pepite_at: row.firstPepiteAt,
  };
}

function favorableEvaluation(): PepiteEvaluation {
  const base = evaluatePepite(
    {
      regime: "notary_online",
      upcoming: true,
      startingPriceEur: 80_000,
      estimate: {
        actionable: true,
        reliability: "forte",
        effectiveSampleSize: 12,
        surfaceEstimated: false,
        publicGatePassed: true,
        centralValueEur: 200_000,
        lowValueEur: 180_000,
      },
      ceiling: { available: true, referenceEur: 120_000, totalCostAt: (price) => price * 1.2 },
      scenarios: null,
      signals: {
        landOrMixed: false,
        occupancy: "libre",
        degradedCondition: false,
        valuationConflict: false,
        aiBlocked: false,
        verificationConflict: false,
        probableDuplicate: false,
        unqualifiedRisks: false,
      },
      flood: { verdict: "none_found", ppriChecked: true },
    },
    "pepite-v2",
  );
  expect(base.status).toBe("pepite");
  return base;
}

function facts(overrides: Row = {}) {
  return {
    regimeKey: "notary_online",
    regimeVersion: VERSIONS.regimes[0] ?? null,
    venueType: "notary",
    startingPriceColumnEur: 80_000,
    estimateComputedAt: "2026-10-30T08:00:00.000Z",
    saleDate: FUTURE,
    occupancy: "libre",
    conditionStatus: "unknown",
    propertyType: "apartment",
    estimateReliability: "forte",
    estimateEffectiveSample: 12,
    gapDiscountPct: 60,
    scenarios: null,
    ...overrides,
  };
}

function setSales(ids: string[], overrides: Partial<OnlineSale> = {}) {
  db.online = ids.map((id) => ({
    id,
    updated_at: BEFORE,
    status: overrides.status ?? "upcoming",
    sale_date: overrides.saleDate === undefined ? FUTURE : overrides.saleDate,
    sale_venue_type: overrides.venueType ?? "notary",
    starting_price_eur: 80_000,
  }));
  db.fullRows = new Map(ids.map((id) => [id, { id, sale_date: FUTURE, tribunal_code: null }]));
  for (const id of ids) {
    db.estimates.set(id, {
      auction_sale_id: id,
      computed_at: "2026-10-30T08:00:00.000Z",
      estimate: { qualityLabel: "forte" },
      model_version_id: null,
      engine_kind: "comparable_ensemble",
    });
    db.evaluations.set(id, { evaluation: favorableEvaluation(), facts: facts() });
  }
}

beforeEach(() => {
  db.mode = "shadow";
  db.modeError = null;
  db.online = [];
  db.stored = [];
  db.storedError = null;
  db.fullRows = new Map();
  db.estimates = new Map();
  db.upserts = [];
  db.upsertError = null;
  db.readError = null;
  db.touched = [];
  db.fullReads = [];
  db.evaluations = new Map();
  db.evaluateError = new Set();
  db.scenarioCalls = [];
  db.missingInputs = new Set();
  db.upsertRejects = new Set();
  db.estimateArgs = new Map();
  db.floodArgs = new Map();
  db.floodRows = [];
  db.communeRows = [];
  vi.unstubAllEnvs();
});

describe("pickPendingSales", () => {
  const dates = new Map<string, string | null>();

  it("ne reprend pas une évaluation récente, à jour et à la bonne version", () => {
    expect(pickPendingSales([online("a")], [stored("a")], dates, VERSIONS, NOW)).toEqual([]);
  });

  it("ordonne : jamais évaluées, version obsolète, vente modifiée, évaluations de plus de 24 h", () => {
    const sales = [
      online("aged", { updatedAt: "2026-10-30T00:00:00.000Z" }),
      online("modified", { updatedAt: AFTER }),
      online("obsolete"),
      online("never-old", { updatedAt: "2026-10-20T00:00:00.000Z" }),
      online("never-new", { updatedAt: AFTER }),
    ];
    const evaluations = [
      stored("aged", { evaluatedAt: "2026-10-31T08:00:00.000Z" }),
      stored("modified"),
      stored("obsolete", { ruleVersion: "pepite-v0" }),
    ];

    expect(pickPendingSales(sales, evaluations, dates, VERSIONS, NOW)).toEqual([
      "never-new",
      "never-old",
      "obsolete",
      "modified",
      "aged",
    ]);
  });

  it("reprend une vente dont l'estimation est plus récente que la dernière évaluation", () => {
    const estimates = new Map([["a", AFTER]]);
    expect(pickPendingSales([online("a")], [stored("a")], estimates, VERSIONS, NOW)).toEqual(["a"]);
    const older = new Map([["a", BEFORE]]);
    expect(pickPendingSales([online("a")], [stored("a")], older, VERSIONS, NOW)).toEqual([]);
  });

  it("reprend une évaluation de plus de 24 h, pas de 24 h pile", () => {
    const exactly = new Date(Date.parse(EVALUATED) + 24 * 3_600_000);
    expect(pickPendingSales([online("a")], [stored("a")], dates, VERSIONS, exactly)).toEqual([]);
    const after = new Date(exactly.getTime() + 1);
    expect(pickPendingSales([online("a")], [stored("a")], dates, VERSIONS, after)).toEqual(["a"]);
  });

  it("une autre version du moteur de plafond ou d'un régime rend l'évaluation obsolète", () => {
    for (const change of [{ engineVersion: "2020-01-01.1" }, { regimeVersion: "regime-inconnu" }]) {
      expect(pickPendingSales([online("a")], [stored("a", change)], dates, VERSIONS, NOW)).toEqual([
        "a",
      ]);
    }
    // Pas de régime (vente non applicable) : rien à comparer.
    expect(isObsoleteEvaluation(stored("a", { regimeVersion: null }), VERSIONS)).toBe(false);
  });

  it("une évaluation stockée « pepite-v1 » (valeur littérale) n'est obsolète que si l'interrupteur v2 est ouvert", () => {
    const evaluation = stored("a", { ruleVersion: "pepite-v1" });
    const closed = currentPepiteVersions({});
    const open = currentPepiteVersions({ PEPITE_RULE_V2_ENABLED: "true" });
    expect(closed.rule).toBe("pepite-v1");
    expect(open.rule).toBe("pepite-v2");
    // Interrupteur absent : la règle v1 reste appliquée, rien à refaire.
    expect(isObsoleteEvaluation(evaluation, closed)).toBe(false);
    expect(pickPendingSales([online("a")], [evaluation], dates, closed, NOW)).toEqual([]);
    // Interrupteur ouvert : l'évaluation v1 est obsolète et la vente est réévaluée.
    expect(isObsoleteEvaluation(evaluation, open)).toBe(true);
    expect(pickPendingSales([online("a")], [evaluation], dates, open, NOW)).toEqual(["a"]);
    // Et réciproquement : une évaluation « pepite-v2 » est obsolète une fois l'interrupteur refermé (retour arrière).
    const v2 = stored("a", { ruleVersion: "pepite-v2" });
    expect(isObsoleteEvaluation(v2, closed)).toBe(true);
    expect(isObsoleteEvaluation(v2, open)).toBe(false);
  });

  it("passe les pépites déjà publiées modifiées avant les ventes jamais évaluées", () => {
    const sales = [
      online("never", { updatedAt: AFTER }),
      online("published-modified", { updatedAt: AFTER }),
      online("published-price", { startingPriceEur: 90_000 }),
      online("published-stable"),
      online("modified-not-published", { updatedAt: AFTER }),
    ];
    const evaluations = [
      stored("published-modified", { isPepite: true }),
      stored("published-price", { isPepite: true }),
      stored("published-stable", { isPepite: true }),
      stored("modified-not-published"),
    ];

    expect(pickPendingSales(sales, evaluations, dates, VERSIONS, NOW)).toEqual([
      "published-modified",
      "published-price",
      "never",
      "modified-not-published",
    ]);
  });

  it("une pépite publiée sans donnée ou évaluée sous une autre version passe en premier", () => {
    const sales = [online("never", { updatedAt: AFTER }), online("missing"), online("obsolete")];
    const evaluations = [
      stored("missing", { isPepite: true, dataMissingSince: "2026-11-01T01:00:00.000Z" }),
      stored("obsolete", { isPepite: true, ruleVersion: "pepite-v0" }),
    ];
    expect(pickPendingSales(sales, evaluations, dates, VERSIONS, NOW)).toEqual([
      "missing",
      "obsolete",
      "never",
    ]);
  });

  it("n'actualise plus par ancienneté une évaluation non applicable d'une vente qui n'est plus à venir", () => {
    const OLD = "2026-09-01T00:00:00.000Z";
    const old = { evaluatedAt: "2026-10-01T00:00:00.000Z", status: "not_applicable" };
    const sales = [
      online("past", { status: "past", updatedAt: OLD }),
      online("elapsed", { saleDate: "2026-10-20T00:00:00.000Z", updatedAt: OLD }),
      online("still-upcoming", { updatedAt: OLD }),
    ];
    const evaluations = [
      stored("past", old),
      stored("elapsed", old),
      stored("still-upcoming", old),
    ];

    expect(pickPendingSales(sales, evaluations, dates, VERSIONS, NOW)).toEqual(["still-upcoming"]);
    // Une vente non applicable qui a changé (reportée, par exemple) est tout de même reprise.
    expect(
      pickPendingSales(
        [online("past", { status: "past", updatedAt: AFTER })],
        [stored("past", { ...old, evaluatedAt: EVALUATED })],
        dates,
        VERSIONS,
        NOW,
      ),
    ).toEqual(["past"]);
  });

  it("départage à égalité par identifiant", () => {
    expect(pickPendingSales([online("b"), online("a")], [], dates, VERSIONS, NOW)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("état stocké et stabilité", () => {
  it("reprend l'état stocké quelle que soit la version : un changement de version ne remet rien à zéro", () => {
    const expected = {
      isPepite: true,
      favorableStreak: 2,
      frozenAt: null,
      lastFavorableAt: "2026-10-31T08:00:00.000Z",
      dataMissingSince: null,
      inputStartingPriceEur: 80_000,
    };
    const current = stored("a", {
      isPepite: true,
      favorableStreak: 2,
      lastFavorableAt: "2026-10-31T08:00:00.000Z",
    });
    expect(storedStateFor(current)).toEqual(expected);
    expect(storedStateFor({ ...current, ruleVersion: "pepite-v0" })).toEqual(expected);
    expect(storedStateFor(undefined)).toBeNull();
  });

  it("vente à venir : statut « upcoming » et date dans le futur", () => {
    expect(isUpcomingSale({ status: "upcoming", saleDate: FUTURE }, NOW)).toBe(true);
    expect(isUpcomingSale({ status: "upcoming", saleDate: "2026-10-01T00:00:00Z" }, NOW)).toBe(
      false,
    );
    expect(isUpcomingSale({ status: "upcoming", saleDate: null }, NOW)).toBe(false);
    expect(isUpcomingSale({ status: "postponed", saleDate: FUTURE }, NOW)).toBe(false);
  });
});

describe("lignes écrites", () => {
  it("une vente non applicable : sans lecture de la ligne, version et motif posés", () => {
    const row = buildNotApplicableRow(
      online("a", { status: "past" }),
      stored("a", { isPepite: true, firstPepiteAt: "2026-10-20T00:00:00.000Z" }),
      VERSIONS,
      NOW,
    );

    expect(row).toMatchObject({
      sale_id: "a",
      rule_version: VERSIONS.rule,
      engine_version: CEILING_ENGINE_VERSION,
      regime_version: null,
      status: "not_applicable",
      is_pepite: false,
      favorable_streak: 0,
      frozen_at: null,
      reason_codes: ["fail:sale_upcoming"],
      input_starting_price_eur: null,
      input_estimate_computed_at: null,
      evaluated_at: NOW.toISOString(),
      first_pepite_at: "2026-10-20T00:00:00.000Z",
    });
  });

  it("le détail privé porte le plafond, le prix probable, la fourchette, les parts et la cohorte", () => {
    const evaluation = favorableEvaluation();
    const details = pepiteDetails(
      evaluation,
      facts({
        scenarios: { reliability: "good", courtSample: 40, nationalSample: 900, band: 4 },
      }) as never,
    ) as Row;

    expect(details).toMatchObject({
      venueType: "notary",
      regime: "notary_online",
      referenceCeilingEur: 120_000,
      centralValueEur: 200_000,
      lowValueEur: 180_000,
      probablePriceEur: 80_000,
      multiplierKey: "start",
      costRatio: 0.48,
      occupancy: "libre",
      estimateReliability: "forte",
      estimateEffectiveSample: 12,
      scenarios: { reliability: "good", courtSample: 40, nationalSample: 900, band: 4 },
      favorable: true,
      holds: true,
      blocking: false,
    });
  });

  it("première date de pépite : posée à la publication, jamais effacée", () => {
    const evaluation = favorableEvaluation();
    const published = buildPepiteRow({
      saleId: "a",
      evaluation,
      stability: {
        isPepite: true,
        favorableStreak: 2,
        frozenAt: null,
        lastFavorableAt: NOW.toISOString(),
        dataMissingSince: null,
        codes: ["stab:entered"],
      },
      facts: facts() as never,
      stored: undefined,
      versions: VERSIONS,
      startingPriceEur: 80_000,
      now: NOW,
    });
    expect(published.first_pepite_at).toBe(NOW.toISOString());
    expect(published.reason_codes).toContain("stab:entered");

    const later = buildPepiteRow({
      saleId: "a",
      evaluation,
      stability: {
        isPepite: false,
        favorableStreak: 0,
        frozenAt: null,
        lastFavorableAt: null,
        dataMissingSince: null,
        codes: [],
      },
      facts: facts() as never,
      stored: stored("a", { firstPepiteAt: "2026-10-20T00:00:00.000Z" }),
      versions: VERSIONS,
      startingPriceEur: 80_000,
      now: NOW,
    });
    expect(later.first_pepite_at).toBe("2026-10-20T00:00:00.000Z");
  });

  it.each([0, -5_000, Number.NaN, null])(
    "une mise à prix de %s est stockée à null (la colonne exige un montant strictement positif)",
    (startingPriceEur) => {
      const row = buildPepiteRow({
        saleId: "a",
        evaluation: favorableEvaluation(),
        stability: {
          isPepite: false,
          favorableStreak: 1,
          frozenAt: null,
          lastFavorableAt: NOW.toISOString(),
          dataMissingSince: null,
          codes: ["stab:streak_1"],
        },
        facts: facts() as never,
        stored: undefined,
        versions: VERSIONS,
        startingPriceEur,
        now: NOW,
      });
      expect(row.input_starting_price_eur).toBeNull();
      expect(row.last_favorable_at).toBe(NOW.toISOString());
      expect(row.data_missing_since).toBeNull();
    },
  );
});

describe("runSalePepitesBatch", () => {
  it("avant la migration (fonction du mode absente) : se termine sans rien lire ni écrire", async () => {
    db.modeError = { code: "PGRST202", message: "Could not find the function" };
    setSales(["a"]);

    const result = await runSalePepitesBatch({ now: NOW });

    expect(result).toMatchObject({ skipped: "not_migrated", evaluated: 0, failed: 0 });
    expect(db.touched).toEqual(["rpc:get_sale_pepite_mode"]);
    expect(db.upserts).toEqual([]);
  });

  it("avant la migration (table absente) : se termine sans rien écrire", async () => {
    db.storedError = { code: "PGRST205", message: "Could not find the table" };
    setSales(["a"]);

    const result = await runSalePepitesBatch({ now: NOW });

    expect(result).toMatchObject({ skipped: "not_migrated", evaluated: 0, mode: "shadow" });
    expect(db.upserts).toEqual([]);
    expect(db.fullReads).toEqual([]);
  });

  it("une table absente à l'écriture est aussi « pas migré »", async () => {
    setSales(["a"]);
    db.upsertError = { code: "42P01", message: 'relation "auction_sale_pepites" does not exist' };

    expect(await runSalePepitesBatch({ now: NOW })).toMatchObject({ skipped: "not_migrated" });
  });

  it("une autre erreur de lecture du mode lève (la passe est en panne)", async () => {
    db.modeError = { code: "XX000", message: "boom" };
    await expect(runSalePepitesBatch({ now: NOW })).rejects.toMatchObject({ message: "boom" });
  });

  it("mode « off » : rien n'est lu ni écrit", async () => {
    db.mode = "off";
    setSales(["a"]);

    const result = await runSalePepitesBatch({ now: NOW });

    expect(result).toMatchObject({ skipped: "mode_off", mode: "off", evaluated: 0 });
    expect(db.touched).toEqual(["rpc:get_sale_pepite_mode"]);
  });

  it("mode « shadow » : évalue, applique la stabilité et écrit", async () => {
    setSales(["new", "second"]);
    db.stored = [
      storedRow("second", { favorableStreak: 1, evaluatedAt: "2026-10-31T08:00:00.000Z" }),
    ];

    const result = await runSalePepitesBatch({ now: NOW });

    expect(result).toMatchObject({
      mode: "shadow",
      skipped: null,
      online: 2,
      pending: 2,
      evaluated: 2,
      favorable: 2,
      published: 1,
      failed: 0,
      remaining: 0,
    });
    const rows = Object.fromEntries(db.upserts.flat().map((row) => [row.sale_id as string, row]));
    // Première évaluation favorable : pas encore publiée.
    expect(rows.new).toMatchObject({ status: "pepite", is_pepite: false, favorable_streak: 1 });
    // Deuxième évaluation favorable consécutive : publiée.
    expect(rows.second).toMatchObject({
      status: "pepite",
      is_pepite: true,
      favorable_streak: 2,
      first_pepite_at: NOW.toISOString(),
      input_starting_price_eur: 80_000,
      input_estimate_computed_at: "2026-10-30T08:00:00.000Z",
      rule_version: "pepite-v1",
      engine_version: CEILING_ENGINE_VERSION,
    });
    expect(rows.second.reason_codes).toEqual(
      expect.arrayContaining(["pass:test_c_cost", "stab:entered"]),
    );
    expect(db.scenarioCalls.sort()).toEqual(["new", "second"]);
  });

  it("un changement de version ne remet pas la série à zéro : la vente est réévaluée aussitôt", async () => {
    setSales(["a"]);
    db.stored = [
      storedRow("a", {
        ruleVersion: "pepite-v0",
        favorableStreak: 1,
        lastFavorableAt: "2026-10-31T08:00:00.000Z",
      }),
    ];

    const result = await runSalePepitesBatch({ now: NOW });

    expect(result).toMatchObject({ evaluated: 1, published: 1 });
    expect(db.upserts.flat()[0]).toMatchObject({
      is_pepite: true,
      favorable_streak: 2,
      rule_version: VERSIONS.rule,
      last_favorable_at: NOW.toISOString(),
    });
  });

  it("une pépite publiée garde sa série et la date de sa dernière évaluation comptée", async () => {
    setSales(["a"]);
    const last = "2026-10-31T08:00:00.000Z";
    db.stored = [
      storedRow("a", {
        isPepite: true,
        favorableStreak: 2,
        lastFavorableAt: last,
        status: "pepite",
        ruleVersion: "pepite-v0",
      }),
    ];

    await runSalePepitesBatch({ now: NOW });

    expect(db.upserts.flat()[0]).toMatchObject({
      is_pepite: true,
      favorable_streak: 2,
      last_favorable_at: last,
      data_missing_since: null,
    });
  });

  it("sans ligne auction_sales (empreinte invérifiable), l'estimation est traitée comme absente", async () => {
    setSales(["with", "without"]);
    db.missingInputs.add("without");

    await runSalePepitesBatch({ now: NOW });

    expect(db.estimateArgs.get("with")).not.toBeNull();
    expect(db.estimateArgs.get("without")).toBeNull();
  });

  it("une ligne refusée par la base est isolée par moitiés : les autres sont écrites, l'erreur n'a pas de montant", async () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    setSales(ids);
    db.upsertRejects.add("d");

    const result = await runSalePepitesBatch({ now: NOW });

    expect(
      db.upserts
        .flat()
        .map((row) => row.sale_id)
        .sort(),
    ).toEqual(["a", "b", "c", "e", "f"]);
    expect(result).toMatchObject({ evaluated: 5, failed: 1 });
    expect(result.errors).toEqual(["Écriture refusée pour la vente d (code 23514)"]);
    // Le code d'erreur de la base est consigné, pas le montant de la contrainte refusée.
    expect(JSON.stringify(result)).not.toContain("80000");
  });

  it("les ventes qui ne sont pas à venir sont « non applicables » sans lire leur ligne complète", async () => {
    setSales(["past"], { status: "past" });

    const result = await runSalePepitesBatch({ now: NOW });

    expect(result).toMatchObject({ evaluated: 1, notApplicable: 1, favorable: 0 });
    expect(db.fullReads).toEqual([]);
    expect(db.upserts.flat()[0]).toMatchObject({
      sale_id: "past",
      status: "not_applicable",
      is_pepite: false,
    });
  });

  it("une évaluation en échec n'empêche pas les autres, et la passe réussit sous 20 % d'échecs", async () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    setSales(ids);
    db.evaluateError.add("a");

    // 1 échec sur 6 (16,7 %) : la passe reste un succès, l'erreur est consignée sans montant.
    const result = await runSalePepitesBatch({ now: NOW });
    expect(result).toMatchObject({ evaluated: 5, failed: 1 });
    expect(result.errors).toEqual(["boom a"]);
    expect(
      db.upserts
        .flat()
        .map((row) => row.sale_id)
        .sort(),
    ).toEqual(["b", "c", "d", "e", "f"]);
  });

  it("échoue quand 20 % ou plus des évaluations tentées sont en échec", async () => {
    setSales(["a", "b", "c", "d", "e"]);
    db.evaluateError.add("a");

    await expect(runSalePepitesBatch({ now: NOW })).rejects.toThrow(
      /partielle : 1 échec\(s\) sur 5/,
    );
  });

  it("échoue quand aucune évaluation n'a abouti", async () => {
    setSales(["a"]);
    db.readError = { message: "lecture impossible" };

    await expect(runSalePepitesBatch({ now: NOW })).rejects.toThrow(
      /impossible : lecture impossible/,
    );
  });

  it("limite le lot et laisse le reste à la passe suivante", async () => {
    setSales(["a", "b", "c"]);

    const result = await runSalePepitesBatch({ now: NOW, limit: 2 });

    expect(result).toMatchObject({ pending: 3, evaluated: 2, remaining: 1 });
  });

  it("n'écrit que dans la table des pépites : ni événement, ni mesure d'audience", async () => {
    setSales(["a"]);

    await runSalePepitesBatch({ now: NOW });

    const writes = db.touched.filter((name) => name.startsWith("auction_sale_pepites"));
    expect(writes.length).toBeGreaterThan(0);
    for (const name of db.touched) {
      expect(name).not.toMatch(/product_events|bid_ceiling|events|analytics|feedback/i);
    }
    expect(db.upserts).toHaveLength(1);
  });

  it("ne met aucun montant dans le résultat de la passe ni dans ses erreurs", async () => {
    setSales(["a", "b"]);
    db.evaluateError.add("a");
    // Un seul échec sur deux dépasse le seuil : on lit l'erreur levée, qui ne doit pas porter de montant.
    let message = "";
    try {
      await runSalePepitesBatch({ now: NOW });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toMatch(/\d{5,}/);

    db.evaluateError.clear();
    const result = await runSalePepitesBatch({ now: NOW });
    expect(JSON.stringify(result)).not.toMatch(/\d{5,}/);
  });
});

describe("pickPendingSales : verdict d'inondation (règle v2)", () => {
  const dates = new Map<string, string | null>();

  it("une pépite publiée dont le verdict d'inondation est plus récent que l'évaluation passe en priorité 0", () => {
    const sales = [online("never"), online("published-flood"), online("plain-flood")];
    const evaluations = [stored("published-flood", { isPepite: true }), stored("plain-flood")];
    const floodChangedAt = new Map([
      ["published-flood", AFTER],
      ["plain-flood", AFTER],
    ]);
    expect(pickPendingSales(sales, evaluations, dates, VERSIONS, NOW, floodChangedAt)).toEqual([
      "published-flood",
      "never",
      "plain-flood",
    ]);
  });

  it("un verdict plus ancien que l'évaluation, ou absent, ne change rien", () => {
    const floodChangedAt = new Map<string, string | null>([
      ["a", BEFORE],
      ["b", null],
    ]);
    expect(
      pickPendingSales(
        [online("a"), online("b")],
        [stored("a", { isPepite: true }), stored("b", { isPepite: true })],
        dates,
        VERSIONS,
        NOW,
        floodChangedAt,
      ),
    ).toEqual([]);
  });
});

describe("runSalePepitesBatch : interrupteur de la règle pepite-v2", () => {
  const POSITION = {
    latitude: 47.399,
    longitude: 0.689,
    location_precision: "address",
    quality_flags: [],
  };

  function setPositioned(ids: string[]) {
    setSales(ids);
    db.online = db.online.map((row) => ({ ...row, ...POSITION }));
  }

  function floodRow(saleId: string, overrides: Row = {}): Row {
    return {
      sale_id: saleId,
      verdict: "exposed",
      derive_version: FLOOD_DERIVE_VERSION,
      position_key: floodPositionKey({
        latitude: POSITION.latitude,
        longitude: POSITION.longitude,
        precision: "address",
        flags: [],
        communeInsee: null,
      }),
      commune_insee: null,
      observed_at: "2026-10-20T08:00:00.000Z",
      attempted_at: "2026-10-20T08:00:00.000Z",
      failure_count: 0,
      ppri_checked: true,
      map_date: "2013-12-18",
      verdict_changed_at: "2026-10-20T08:00:00.000Z",
      ...overrides,
    };
  }

  it("fermé (défaut) : la règle appliquée est pepite-v1 et la table d'inondation n'est jamais lue", async () => {
    setPositioned(["a"]);
    const result = await runSalePepitesBatch({ now: NOW });

    expect(result).toMatchObject({ ruleVersion: "pepite-v1", evaluated: 1, floodVerdicts: null });
    expect(db.touched).not.toContain("auction_sale_flood_risk");
    expect(db.touched).not.toContain("auction_sale_communes");
    expect(db.floodArgs.get("a")?.ruleVersion).toBe("pepite-v1");
    expect(db.upserts.flat()[0]).toMatchObject({ rule_version: "pepite-v1" });
    expect((db.upserts.flat()[0].details as Row).flood).toBeNull();
  });

  it("fermé : un verdict élevé stocké ne change rien (aucun résultat de la v1 ne bouge)", async () => {
    setPositioned(["a"]);
    db.floodRows = [floodRow("a", { verdict: "high" })];
    const result = await runSalePepitesBatch({ now: NOW });
    expect(result.floodVerdicts).toBeNull();
    expect(db.floodArgs.get("a")?.flood).toMatchObject({ verdict: "unknown" });
  });

  it("ouvert : la règle appliquée est pepite-v2, le verdict stocké est lu et gardé dans le détail", async () => {
    vi.stubEnv("PEPITE_RULE_V2_ENABLED", "true");
    setPositioned(["a"]);
    db.floodRows = [floodRow("a")];

    const result = await runSalePepitesBatch({ now: NOW });

    expect(result).toMatchObject({
      ruleVersion: "pepite-v2",
      evaluated: 1,
      floodVerdicts: { exposed: 1, high: 0, none_found: 0, no_signal: 0, unknown: 0 },
    });
    expect(db.floodArgs.get("a")).toEqual({
      ruleVersion: "pepite-v2",
      flood: {
        verdict: "exposed",
        observedAt: "2026-10-20T08:00:00.000Z",
        mapDate: "2013-12-18",
        ppriChecked: true,
      },
    });
    const row = db.upserts.flat()[0];
    expect(row.rule_version).toBe("pepite-v2");
    // Le détail ne garde que le verdict, deux dates et le drapeau des PPRi : ni coordonnée, ni commune.
    expect((row.details as Row).flood).toEqual({
      verdict: "exposed",
      observedAt: "2026-10-20T08:00:00.000Z",
      mapDate: "2013-12-18",
      ppriChecked: true,
    });
    expect(JSON.stringify(row.details)).not.toMatch(/47\.39|0\.689/);
  });

  it("ouvert : un verdict dont le périmètre des PPRi n'a pas été lu est gardé avec son drapeau dans le détail", async () => {
    vi.stubEnv("PEPITE_RULE_V2_ENABLED", "true");
    setPositioned(["unread"]);
    db.floodRows = [floodRow("unread", { verdict: "none_found", ppri_checked: false })];

    const result = await runSalePepitesBatch({ now: NOW });

    expect(db.floodArgs.get("unread")).toMatchObject({
      flood: { verdict: "none_found", ppriChecked: false },
    });
    expect(result.floodVerdicts?.none_found).toBe(1);
    const row = db.upserts.flat()[0];
    expect((row.details as Row).flood).toMatchObject({ verdict: "none_found", ppriChecked: false });
    // La décision d'entrée (« contrôlé » manquant) est celle de la règle, testée dans pepite-input.test.ts.
  });

  it("ouvert : un verdict d'une autre position, expiré ou absent compte pour inconnu (jamais une panne)", async () => {
    vi.stubEnv("PEPITE_RULE_V2_ENABLED", "1");
    setPositioned(["moved", "expired", "none"]);
    db.floodRows = [
      floodRow("moved", { position_key: "point:address:0000000000000000" }),
      floodRow("expired", { observed_at: "2026-04-01T08:00:00.000Z" }),
    ];

    const result = await runSalePepitesBatch({ now: NOW });

    expect(result.floodVerdicts).toMatchObject({ unknown: 3 });
    expect(result.failed).toBe(0);
  });

  it("ouvert : sans la table d'inondation (migration non appliquée), la passe se termine sans rien écrire", async () => {
    vi.stubEnv("PEPITE_RULE_V2_ENABLED", "true");
    setPositioned(["a"]);
    db.floodRows = null;

    expect(await runSalePepitesBatch({ now: NOW })).toMatchObject({
      skipped: "not_migrated",
      evaluated: 0,
    });
    expect(db.upserts).toEqual([]);
  });

  it("ouvert : sans la table des communes, même réponse", async () => {
    vi.stubEnv("PEPITE_RULE_V2_ENABLED", "true");
    setPositioned(["a"]);
    db.communeRows = null;
    expect(await runSalePepitesBatch({ now: NOW })).toMatchObject({ skipped: "not_migrated" });
  });

  it("ouvert : une pépite publiée dont le verdict a changé après son évaluation est refaite avant les autres", async () => {
    vi.stubEnv("PEPITE_RULE_V2_ENABLED", "true");
    setPositioned(["fresh", "published"]);
    db.stored = [
      storedRow("published", {
        ruleVersion: "pepite-v2",
        isPepite: true,
        favorableStreak: 2,
        status: "pepite",
        evaluatedAt: EVALUATED,
      }),
      storedRow("fresh", { ruleVersion: "pepite-v2", evaluatedAt: EVALUATED }),
    ];
    db.floodRows = [floodRow("published", { verdict_changed_at: AFTER })];

    const result = await runSalePepitesBatch({ now: NOW, limit: 1 });

    expect(result.evaluated).toBe(1);
    expect(db.upserts.flat()[0].sale_id).toBe("published");
  });
});
