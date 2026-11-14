import { randomUUID } from "node:crypto";

/**
 * Faux client Supabase en mémoire pour les tests de route des données personnelles.
 *
 * Il applique vraiment les filtres (`eq`, `neq`, `in`, `is`, `gt`, `gte`, `lt`, `lte`) aux lignes
 * des tables, sans politique RLS : une ligne d'un autre compte n'est écartée que si le code filtre
 * lui-même par propriétaire. Un test qui retire ce filtre du code voit donc la ligne d'autrui lue,
 * modifiée ou supprimée. `single()` sans ligne rend l'erreur PGRST116 de PostgREST (objet simple,
 * pas une `Error`), comme le vrai client.
 */

export type FakeRow = Record<string, unknown>;
type FakeFilter = {
  op: "eq" | "neq" | "in" | "is" | "gt" | "gte" | "lt" | "lte";
  column: string;
  value: unknown;
};
type FakeAction = "select" | "insert" | "update" | "delete" | "upsert";
type FakeQuery = {
  table: string;
  action: FakeAction;
  filters: FakeFilter[];
  payload?: unknown;
};
type FakeResult = {
  data: unknown;
  error: { code: string; message: string; details?: string; hint?: string | null } | null;
  count: number | null;
};
export type FakeRpcHandler = (name: string, args: Record<string, unknown>) => FakeResult;

export type FakeSupabase = {
  client: {
    from: (table: string) => FakeQueryBuilder;
    rpc: (name: string, args?: Record<string, unknown>) => FakeRpcBuilder;
    auth: { admin: { getUserById: (userId: string) => Promise<unknown> } };
  };
  tables: Record<string, FakeRow[]>;
  queries: FakeQuery[];
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  /** Les lignes de `table` qui vérifient toutes les paires colonne/valeur de `match`. */
  rows: (table: string, match?: FakeRow) => FakeRow[];
};

const NO_ROWS_ERROR = {
  code: "PGRST116",
  details: "The result contains 0 rows",
  hint: null,
  message: "Cannot coerce the result to a single JSON object",
};

export function createFakeSupabase(
  seed: Record<string, FakeRow[]> = {},
  options: {
    rpc?: FakeRpcHandler;
    /** Comptes rendus par `auth.admin.getUserById`. */
    users?: Record<string, FakeRow>;
    /** Valeurs par défaut des colonnes à l'insertion (les `default` de la migration). */
    defaults?: Record<string, FakeRow>;
  } = {},
): FakeSupabase {
  const tables: Record<string, FakeRow[]> = Object.fromEntries(
    Object.entries(seed).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]),
  );
  const queries: FakeQuery[] = [];
  const rpcCalls: FakeSupabase["rpcCalls"] = [];
  const table = (name: string) => (tables[name] ??= []);

  const fake: FakeSupabase = {
    client: {
      from: (name: string) =>
        new FakeQueryBuilder(name, table(name), queries, options.defaults?.[name] ?? {}),
      rpc: (name: string, args: Record<string, unknown> = {}) => {
        rpcCalls.push({ name, args });
        return new FakeRpcBuilder(() =>
          options.rpc
            ? options.rpc(name, args)
            : { data: null, error: { code: "PGRST202", message: "rpc absent" }, count: null },
        );
      },
      auth: {
        admin: {
          getUserById: async (userId: string) => {
            const user = options.users?.[userId];
            return user
              ? { data: { user }, error: null }
              : { data: { user: null }, error: { message: "User not found" } };
          },
        },
      },
    },
    tables,
    queries,
    rpcCalls,
    rows: (name, match = {}) =>
      table(name).filter((row) =>
        Object.entries(match).every(([column, value]) => row[column] === value),
      ),
  };
  return fake;
}

type Mode = "many" | "single" | "maybeSingle";

class FakeQueryBuilder implements PromiseLike<FakeResult> {
  private action: FakeAction | null = null;
  private payload: unknown;
  private onConflict: string[] = ["id"];
  private columns = "*";
  private head = false;
  private filters: FakeFilter[] = [];
  private orderings: Array<{ column: string; ascending: boolean }> = [];
  private limitCount: number | null = null;
  private offset = 0;
  private mode: Mode = "many";

  constructor(
    private readonly name: string,
    private readonly rows: FakeRow[],
    private readonly queries: FakeQuery[],
    private readonly defaults: FakeRow,
  ) {}

  select(columns = "*", options: { head?: boolean; count?: string } = {}) {
    this.action ??= "select";
    this.columns = columns;
    this.head = options.head === true;
    return this;
  }
  insert(payload: FakeRow | FakeRow[]) {
    this.action = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: FakeRow) {
    this.action = "update";
    this.payload = payload;
    return this;
  }
  delete() {
    this.action = "delete";
    return this;
  }
  upsert(payload: FakeRow | FakeRow[], options: { onConflict?: string } = {}) {
    this.action = "upsert";
    this.payload = payload;
    if (options.onConflict) this.onConflict = options.onConflict.split(",").map((c) => c.trim());
    return this;
  }
  eq(column: string, value: unknown) {
    return this.filter("eq", column, value);
  }
  neq(column: string, value: unknown) {
    return this.filter("neq", column, value);
  }
  in(column: string, value: unknown[]) {
    return this.filter("in", column, value);
  }
  is(column: string, value: unknown) {
    return this.filter("is", column, value);
  }
  gt(column: string, value: unknown) {
    return this.filter("gt", column, value);
  }
  gte(column: string, value: unknown) {
    return this.filter("gte", column, value);
  }
  lt(column: string, value: unknown) {
    return this.filter("lt", column, value);
  }
  lte(column: string, value: unknown) {
    return this.filter("lte", column, value);
  }
  order(column: string, options: { ascending?: boolean } = {}) {
    this.orderings.push({ column, ascending: options.ascending !== false });
    return this;
  }
  limit(count: number) {
    this.limitCount = count;
    return this;
  }
  range(from: number, to: number) {
    this.offset = from;
    this.limitCount = to - from + 1;
    return this;
  }
  single() {
    this.mode = "single";
    return this;
  }
  maybeSingle() {
    this.mode = "maybeSingle";
    return this;
  }

  then<TResult1 = FakeResult, TResult2 = never>(
    onfulfilled?: ((value: FakeResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => this.execute())
      .then(onfulfilled, onrejected);
  }

  private filter(op: FakeFilter["op"], column: string, value: unknown) {
    this.filters.push({ op, column, value });
    return this;
  }

  private matches(row: FakeRow): boolean {
    return this.filters.every(({ op, column, value }) => {
      const current = row[column] ?? null;
      switch (op) {
        case "eq":
          return current === value;
        case "neq":
          return current !== value;
        case "in":
          return (value as unknown[]).includes(current);
        case "is":
          return current === value;
        // Comme en SQL, une comparaison avec NULL n'est jamais vraie : la ligne est écartée.
        case "gt":
          return current !== null && String(current) > String(value);
        case "gte":
          return current !== null && String(current) >= String(value);
        case "lt":
          return current !== null && String(current) < String(value);
        case "lte":
          return current !== null && String(current) <= String(value);
      }
    });
  }

  private execute(): FakeResult {
    const action = this.action ?? "select";
    this.queries.push({
      table: this.name,
      action,
      filters: [...this.filters],
      payload: this.payload,
    });
    const now = new Date().toISOString();
    let result: FakeRow[];

    if (action === "insert" || action === "upsert") {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload as FakeRow];
      result = incoming.map((row) => {
        const existing =
          action === "upsert"
            ? this.rows.find((candidate) =>
                this.onConflict.every((column) => candidate[column] === row[column]),
              )
            : undefined;
        const defined = Object.fromEntries(
          Object.entries(row).filter(([, value]) => value !== undefined),
        );
        if (existing) return Object.assign(existing, defined, { updated_at: now });
        const created = {
          id: randomUUID(),
          created_at: now,
          updated_at: now,
          ...this.defaults,
          ...defined,
        };
        this.rows.push(created);
        return created;
      });
    } else {
      result = this.rows.filter((row) => this.matches(row));
      if (action === "update") {
        result.forEach((row) => Object.assign(row, this.payload as FakeRow));
      } else if (action === "delete") {
        for (const row of result) this.rows.splice(this.rows.indexOf(row), 1);
      }
    }

    for (const { column, ascending } of [...this.orderings].reverse()) {
      result = [...result].sort((a, b) => {
        const left = String(a[column] ?? "");
        const right = String(b[column] ?? "");
        return ascending ? left.localeCompare(right) : right.localeCompare(left);
      });
    }
    const count = result.length;
    if (this.limitCount != null) result = result.slice(this.offset, this.offset + this.limitCount);
    const data = result.map((row) => project({ ...row }, this.columns));

    if (this.head) return { data: null, error: null, count };
    if (this.mode === "single") {
      return data.length === 1
        ? { data: data[0], error: null, count }
        : { data: null, error: NO_ROWS_ERROR, count: null };
    }
    if (this.mode === "maybeSingle") {
      if (data.length > 1) return { data: null, error: NO_ROWS_ERROR, count: null };
      return { data: data[0] ?? null, error: null, count };
    }
    return { data, error: null, count };
  }
}

class FakeRpcBuilder implements PromiseLike<FakeResult> {
  private mode: Mode = "many";
  constructor(private readonly run: () => FakeResult) {}

  single() {
    this.mode = "single";
    return this;
  }
  maybeSingle() {
    this.mode = "maybeSingle";
    return this;
  }
  then<TResult1 = FakeResult, TResult2 = never>(
    onfulfilled?: ((value: FakeResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => {
        const result = this.run();
        if (this.mode === "many" || result.error || !Array.isArray(result.data)) return result;
        return { ...result, data: result.data[0] ?? null };
      })
      .then(onfulfilled, onrejected);
  }
}

/** Projection des listes simples de colonnes ; une sélection avec alias ou jointure rend la ligne entière. */
function project(row: FakeRow, columns: string): FakeRow {
  if (columns.trim() === "*" || !/^[\w\s,]+$/.test(columns)) return row;
  return Object.fromEntries(
    columns
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean)
      .map((column) => [column, row[column] ?? null]),
  );
}
