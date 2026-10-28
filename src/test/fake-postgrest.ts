import { readFileSync } from "node:fs";

/**
 * Faux PostgREST partagé par les tests des écrivains en base (inondation, pépites, communes…).
 *
 * Il rejoue ce que la base refuserait à l'écriture d'un `upsert` groupé, d'après la migration qui
 * crée la table (le SQL fait foi, aucune liste recopiée à la main) :
 * - l'union des clés de toutes les lignes forme les colonnes de l'envoi ; une colonne absente d'une
 *   ligne mais présente dans une autre vaut NULL (`Prefer: missing=null`, le défaut de postgrest-js)
 *   ou sa valeur par défaut avec `defaultToNull: false` (`missing=default`) ;
 * - une colonne `NOT NULL` reçoit NULL : 23502 ;
 * - un `CHECK` n'est pas vérifié : 23514 (sous-ensemble évalué : `in (...)`, `~ '...'`,
 *   `col = 'x'`, `is [not] null`, `length(btrim(col)) > 0`, `col >= n`, `jsonb_typeof(col) = '...'`,
 *   combinés par `and` / `or` ; une expression hors de ce sous-ensemble est tenue pour vraie) ;
 * - deux lignes de même clé dans un envoi à `onConflict` : 21000, « cannot affect row a second time ».
 */

export type PostgrestRow = Record<string, unknown>;
export type PostgrestError = { code: string; message: string };

type Check = { name: string; expression: string };
type Column = { name: string; notNull: boolean; hasDefault: boolean };
export type TableSchema = {
  table: string;
  columns: Map<string, Column>;
  primaryKey: string[];
  checks: Check[];
};

const MIGRATIONS = new URL("../../supabase/migrations/", import.meta.url);

/** Lit la définition `create table public.<table>` dans un fichier de `supabase/migrations/`. */
export function readTableSchema(migrationFile: string, table: string): TableSchema {
  const sql = readFileSync(new URL(migrationFile, MIGRATIONS), "utf8").replace(/--[^\n]*/g, "");
  return parseCreateTable(sql, table);
}

export function parseCreateTable(sql: string, table: string): TableSchema {
  const head = new RegExp(
    `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?public\\.${table}\\s*\\(`,
    "i",
  );
  const match = head.exec(sql);
  if (!match) throw new Error(`create table public.${table} introuvable dans la migration`);
  const start = match.index + match[0].length;
  let depth = 1;
  let end = start;
  for (; end < sql.length && depth > 0; end += 1) {
    if (sql[end] === "'") end = skipQuoted(sql, end);
    else if (sql[end] === "(") depth += 1;
    else if (sql[end] === ")") depth -= 1;
  }
  const items = splitTopLevel(sql.slice(start, end - 1));
  const schema: TableSchema = { table, columns: new Map(), primaryKey: [], checks: [] };
  for (const raw of items) {
    const item = raw.trim().replace(/\s+/g, " ");
    if (!item) continue;
    const constraint = /^constraint (\w+) (.*)$/i.exec(item);
    const body = constraint ? constraint[2] : item;
    const check = /^check\s*\(/i.exec(body);
    if (check) {
      schema.checks.push({
        name: constraint?.[1] ?? `${table}_check`,
        expression: balanced(body, check[0].length - 1),
      });
      continue;
    }
    const primary = /^primary key\s*\(([^)]*)\)/i.exec(body);
    if (primary) {
      schema.primaryKey.push(...primary[1].split(",").map((name) => name.trim()));
      continue;
    }
    if (/^(?:unique|foreign key|exclude)\b/i.test(body)) continue;
    const column = /^"?(\w+)"?\s+(.*)$/.exec(item);
    if (!column) continue;
    const [, name, rest] = column;
    const isPrimary = /\bprimary key\b/i.test(rest);
    if (isPrimary) schema.primaryKey.push(name);
    schema.columns.set(name, {
      name,
      notNull: isPrimary || /\bnot null\b/i.test(rest),
      hasDefault: /\bdefault\b/i.test(rest),
    });
    for (const inline of rest.matchAll(/\bcheck\s*\(/gi)) {
      schema.checks.push({
        name: `${table}_${name}_check`,
        expression: balanced(rest, inline.index + inline[0].length - 1),
      });
    }
  }
  for (const key of schema.primaryKey) {
    const column = schema.columns.get(key);
    if (column) column.notNull = true;
  }
  return schema;
}

/** Texte entre la parenthèse ouvrante à `open` et sa fermante. */
function balanced(text: string, open: number): string {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "'") index = skipQuoted(text, index);
    else if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index).trim();
    }
  }
  return text.slice(open + 1).trim();
}

function skipQuoted(text: string, quote: number): number {
  let index = quote + 1;
  while (index < text.length) {
    if (text[index] === "'") {
      if (text[index + 1] === "'") index += 2;
      else return index;
    } else index += 1;
  }
  return index;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'") {
      const end = skipQuoted(text, index);
      current += text.slice(index, end + 1);
      index = end;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts;
}

type Effective = Map<string, unknown | typeof DEFAULTED>;
const DEFAULTED = Symbol("default");

/** Rend la première erreur que la base renverrait pour cet envoi, ou `null`. */
export function validateUpsert(
  schema: TableSchema,
  rows: readonly PostgrestRow[],
  options: { defaultToNull?: boolean; onConflict?: string } = {},
): PostgrestError | null {
  const defaultToNull = options.defaultToNull ?? true;
  const sent = new Set(
    rows.flatMap((row) => Object.keys(row).filter((key) => row[key] !== undefined)),
  );
  for (const key of sent) {
    if (!schema.columns.has(key)) {
      return {
        code: "PGRST204",
        message: `Could not find the '${key}' column of '${schema.table}'`,
      };
    }
  }
  const conflictColumns = options.onConflict
    ? options.onConflict.split(",").map((name) => name.trim())
    : schema.primaryKey;
  const seen = new Set<string>();
  for (const row of rows) {
    const values: Effective = new Map();
    for (const column of schema.columns.values()) {
      const given = row[column.name];
      if (given !== undefined) values.set(column.name, given);
      else if (!sent.has(column.name))
        values.set(column.name, column.hasDefault ? DEFAULTED : null);
      else values.set(column.name, defaultToNull || !column.hasDefault ? null : DEFAULTED);
    }
    for (const column of schema.columns.values()) {
      if (column.notNull && values.get(column.name) == null) {
        return {
          code: "23502",
          message: `null value in column "${column.name}" of relation "${schema.table}" violates not-null constraint`,
        };
      }
    }
    for (const check of schema.checks) {
      if (!evaluateCheck(check.expression, values)) {
        return {
          code: "23514",
          message: `new row for relation "${schema.table}" violates check constraint "${check.name}"`,
        };
      }
    }
    if (conflictColumns.length) {
      const key = JSON.stringify(conflictColumns.map((name) => values.get(name) ?? null));
      if (seen.has(key)) {
        return {
          code: "21000",
          message: "ON CONFLICT DO UPDATE command cannot affect row a second time",
        };
      }
      seen.add(key);
    }
  }
  return null;
}

/** `true` si l'expression est vraie, ou si on ne sait pas l'évaluer (valeur par défaut, forme inconnue). */
function evaluateCheck(expression: string, values: Effective): boolean {
  const expr = stripOuter(expression.trim());
  const orParts = splitKeyword(expr, "or");
  if (orParts.length > 1) return orParts.some((part) => evaluateCheck(part, values));
  const andParts = splitKeyword(expr, "and");
  if (andParts.length > 1) return andParts.every((part) => evaluateCheck(part, values));
  return evaluateAtom(expr, values);
}

function stripOuter(expr: string): string {
  let current = expr;
  while (current.startsWith("(") && balanced(current, 0).length === current.length - 2) {
    current = current.slice(1, -1).trim();
  }
  return current;
}

function splitKeyword(expr: string, keyword: "and" | "or"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  const pattern = new RegExp(`^\\s${keyword}\\s`, "i");
  for (let index = 0; index < expr.length; index += 1) {
    if (expr[index] === "'") index = skipQuoted(expr, index);
    else if (expr[index] === "(") depth += 1;
    else if (expr[index] === ")") depth -= 1;
    else if (depth === 0 && pattern.test(expr.slice(index, index + keyword.length + 2))) {
      parts.push(expr.slice(last, index));
      last = index + keyword.length + 2;
    }
  }
  parts.push(expr.slice(last));
  return parts.map((part) => part.trim());
}

function evaluateAtom(atom: string, values: Effective): boolean {
  const value = (name: string): unknown => values.get(name);
  const unknown = (name: string) => value(name) === DEFAULTED;
  let match: RegExpExecArray | null;
  if ((match = /^(\w+) is not null$/i.exec(atom)))
    return unknown(match[1]) || value(match[1]) != null;
  if ((match = /^(\w+) is null$/i.exec(atom))) return unknown(match[1]) || value(match[1]) == null;
  // Comme SQL : une comparaison avec NULL n'est ni vraie ni fausse, et un CHECK « inconnu » passe.
  const column = /^(?:length\(btrim\(|jsonb_typeof\()?(\w+)/i.exec(atom)?.[1];
  if (column && value(column) == null) return true;
  if ((match = /^(\w+) in \((.*)\)$/i.exec(atom))) {
    if (unknown(match[1])) return true;
    const allowed = [...match[2].matchAll(/'((?:[^']|'')*)'/g)].map((entry) =>
      entry[1].replace(/''/g, "'"),
    );
    return allowed.includes(String(value(match[1])));
  }
  if ((match = /^(\w+) ~ '((?:[^']|'')*)'$/i.exec(atom))) {
    if (unknown(match[1])) return true;
    const given = value(match[1]);
    return typeof given === "string" && new RegExp(match[2].replace(/''/g, "'")).test(given);
  }
  if ((match = /^(\w+) = '((?:[^']|'')*)'$/i.exec(atom))) {
    return unknown(match[1]) || value(match[1]) === match[2].replace(/''/g, "'");
  }
  if ((match = /^length\(btrim\((\w+)\)\) > 0$/i.exec(atom))) {
    if (unknown(match[1])) return true;
    const given = value(match[1]);
    return typeof given === "string" && given.trim().length > 0;
  }
  if ((match = /^(\w+) >= (-?\d+(?:\.\d+)?)$/i.exec(atom))) {
    if (unknown(match[1])) return true;
    const given = value(match[1]);
    return typeof given === "number" && given >= Number(match[2]);
  }
  if ((match = /^jsonb_typeof\((\w+)\) = '(\w+)'$/i.exec(atom))) {
    if (unknown(match[1])) return true;
    const given = value(match[1]);
    const type = Array.isArray(given) ? "array" : given === null ? "null" : typeof given;
    return type === match[2];
  }
  return true;
}
