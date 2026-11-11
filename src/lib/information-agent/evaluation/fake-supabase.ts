import "server-only";

/**
 * Base en mémoire du banc d'évaluation : elle remplace `supabaseAdmin` (par `vi.mock` dans le test du banc)
 * pour que la VRAIE chaîne tourne sans réseau : enregistrement des faits des règles
 * (`persistFactCandidates`) et passe de simulation du moteur (`runAutoPublicationSimulation`). Elle honore
 * les seuls appels que ces deux fonctions font (`select`, `eq`, `in`, `gte`, `order`, `range`, `limit`,
 * `single`, `maybeSingle`, `upsert`, la RPC du journal) et lève une erreur sur tout autre appel : un
 * changement de la chaîne casse le banc au lieu d'être ignoré.
 */

export type Row = Record<string, unknown>;

type Result = {
  data: unknown;
  error: { code: string; message: string } | null;
  count?: number | null;
};

const UPSERT_CONFLICT_COLUMNS: Record<string, string[]> = {
  information_agent_fact_candidates: [
    "message_id",
    "fact_key",
    "evidence_asset_id",
    "source_page",
    "display_value",
  ],
};

export class EvaluationDatabase {
  tables: Record<string, Row[]> = {};
  private sequence = 0;

  constructor(private readonly prefix: string) {}

  nextId(kind: string): string {
    this.sequence += 1;
    return `${this.prefix}-${kind}-${String(this.sequence).padStart(3, "0")}`;
  }

  rows(table: string): Row[] {
    this.tables[table] ??= [];
    return this.tables[table];
  }

  from(table: string) {
    return new Query(this, table);
  }

  /** Seule RPC appelée par la passe : l'inscription d'une décision au journal. */
  rpc(name: string, args: Row): Promise<Result> {
    if (name !== "record_information_agent_auto_publication_decision") {
      throw new Error(`Banc d'évaluation : RPC inattendue ${name}`);
    }
    const mode = this.rows("information_agent_auto_publication_settings")[0]?.mode;
    if (mode !== "simulation") return Promise.resolve({ data: false, error: null });
    const fact = this.rows("information_agent_fact_candidates").find(
      (row) => row.id === args.p_fact_id,
    );
    if (!fact) return Promise.resolve({ data: false, error: null });
    this.rows("information_agent_auto_publication_decisions").push({
      id: this.nextId("decision"),
      fact_id: args.p_fact_id,
      case_id: fact.case_id,
      sale_id: fact.sale_id,
      fact_key: args.p_fact_key,
      outcome: args.p_outcome,
      reasons: args.p_reasons,
      policy_version: args.p_policy_version,
      decided_at: "2026-11-20T12:00:00.000Z",
    });
    return Promise.resolve({ data: true, error: null });
  }
}

class Query {
  private readonly filters: Array<(row: Row) => boolean> = [];
  private readonly orders: Array<[string, boolean]> = [];
  private from = 0;
  private to = Number.POSITIVE_INFINITY;
  private limitCount = Number.POSITIVE_INFINITY;
  private counted = false;

  constructor(
    private readonly database: EvaluationDatabase,
    private readonly table: string,
  ) {}

  select(_columns: string, options?: { count?: string }) {
    this.counted = options?.count === "exact";
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  in(column: string, values: readonly unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  gte(column: string, value: string) {
    this.filters.push((row) => String(row[column]) >= value);
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orders.push([column, options?.ascending ?? true]);
    return this;
  }

  range(start: number, end: number) {
    this.from = start;
    this.to = end;
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
    return this;
  }

  single(): Promise<Result> {
    const { data } = this.run();
    const rows = data as Row[];
    if (rows.length !== 1) {
      return Promise.resolve({ data: null, error: { code: "PGRST116", message: "not single" } });
    }
    return Promise.resolve({ data: rows[0], error: null });
  }

  maybeSingle(): Promise<Result> {
    const { data } = this.run();
    return Promise.resolve({ data: (data as Row[])[0] ?? null, error: null });
  }

  /** Insertion avec `ignoreDuplicates` sur la contrainte d'unicité de la table, comme PostgREST. */
  upsert(rows: Row[], options: { onConflict: string; ignoreDuplicates: boolean }): Promise<Result> {
    const columns = UPSERT_CONFLICT_COLUMNS[this.table];
    if (!columns || options.onConflict !== columns.join(",") || !options.ignoreDuplicates) {
      throw new Error(`Banc d'évaluation : upsert inattendu sur ${this.table}`);
    }
    const table = this.database.rows(this.table);
    const conflictKey = (row: Row) => JSON.stringify(columns.map((column) => row[column] ?? null));
    for (const row of rows) {
      if (table.some((existing) => conflictKey(existing) === conflictKey(row))) continue;
      table.push({
        id: this.database.nextId("fact"),
        evidence_asset_id: null,
        source_page: null,
        reviewed_by: null,
        // Valeur par défaut de la colonne en base (`metadata jsonb not null default '{}'`).
        metadata: {},
        ...row,
      });
    }
    return Promise.resolve({ data: null, error: null });
  }

  then<T>(resolve: (value: Result) => T) {
    return Promise.resolve(this.run()).then(resolve);
  }

  private run(): Result {
    let rows = this.database
      .rows(this.table)
      .filter((row) => this.filters.every((test) => test(row)));
    const total = rows.length;
    rows = [...rows].sort((left, right) => {
      for (const [column, ascending] of this.orders) {
        const a = String(left[column] ?? "");
        const b = String(right[column] ?? "");
        if (a !== b) return (a < b ? -1 : 1) * (ascending ? 1 : -1);
      }
      return 0;
    });
    rows = rows.slice(this.from, Math.min(this.to + 1, rows.length)).slice(0, this.limitCount);
    return { data: rows, error: null, count: this.counted ? total : null };
  }
}

/** Base courante du banc ; `evaluationSupabase` la sert à la place du client Supabase. */
let active: EvaluationDatabase | null = null;

export function activateEvaluationDatabase(database: EvaluationDatabase): EvaluationDatabase {
  active = database;
  return database;
}

function current(): EvaluationDatabase {
  if (!active) throw new Error("Banc d'évaluation : aucune base en mémoire active");
  return active;
}

export const evaluationSupabase = {
  from: (table: string) => current().from(table),
  rpc: (name: string, args: Row) => current().rpc(name, args),
};
