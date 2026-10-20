import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/billing", () => ({ getStripe: () => ({}) }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { ERASURE_TABLES } from "./privacy-requests";

/**
 * Compare `ERASURE_TABLES` aux tables du schéma public qui ont une clé étrangère vers `auth.users`,
 * lues dans `supabase/migrations/`. Une table ajoutée avec une telle clé (`on delete cascade`) doit être
 * ajoutée à `ERASURE_TABLES` (suppression explicite, avec compte pour le journal d'effacement) ou
 * déclarée ici avec la raison pour laquelle la cascade suffit.
 */
const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

/** Tables dont la seule suppression est la cascade depuis `auth.users`, volontairement. */
const CASCADE_ONLY: Readonly<Record<string, string>> = {
  api_rate_limit_buckets:
    "compteurs de limitation de débit (clé de bucket, horodatage) : aucun contenu du compte, expirés en continu",
};

/** Tables conservées ou détachées (`on delete set null`) : preuve de traitement, obligations légales. */
const RETAINED_TABLES = ["data_subject_requests", "commercial_acceptances", "valuation_estimates"];

type ForeignKey = { table: string; column: string; onDelete: string };

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

/** Découpe un corps de table en éléments séparés par une virgule de premier niveau. */
function splitTopLevel(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of body) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      items.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) items.push(current);
  return items;
}

function onDeleteOf(text: string): string {
  const match = /on\s+delete\s+(cascade|set\s+null|restrict|no\s+action)/i.exec(text);
  return match ? match[1].toLowerCase().replace(/\s+/g, " ") : "no action";
}

/** Clés étrangères vers `auth.users` des tables du schéma public, et tables créées puis supprimées. */
function readSchema(): { foreignKeys: ForeignKey[]; tables: Set<string> } {
  const tables = new Set<string>();
  const dropped = new Set<string>();
  const foreignKeys = new Map<string, ForeignKey>();
  const addKey = (table: string, column: string, text: string) =>
    foreignKeys.set(`${table}.${column}`, { table, column, onDelete: onDeleteOf(text) });

  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const sql = stripComments(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));

    const createTable = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:(\w+)\.)?"?(\w+)"?\s*\(/gi;
    for (let match = createTable.exec(sql); match; match = createTable.exec(sql)) {
      const schema = match[1] ?? "public";
      if (schema !== "public") continue;
      const table = match[2];
      tables.add(table);
      const start = match.index + match[0].length;
      let depth = 1;
      let end = start;
      while (end < sql.length && depth > 0) {
        if (sql[end] === "(") depth += 1;
        if (sql[end] === ")") depth -= 1;
        end += 1;
      }
      for (const item of splitTopLevel(sql.slice(start, end - 1))) {
        const column = /^\s*"?(\w+)"?\s+[a-z]/i.exec(item);
        const inline = /references\s+auth\.users/i.test(item);
        if (inline && column && !/^\s*(constraint|foreign|primary|unique|check)\b/i.test(item)) {
          addKey(table, column[1], item);
        }
        const table_constraint =
          /foreign\s+key\s*\(\s*"?(\w+)"?\s*\)\s*references\s+auth\.users/i.exec(item);
        if (table_constraint) addKey(table, table_constraint[1], item);
      }
    }

    const alterTable =
      /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:(\w+)\.)?"?(\w+)"?\s+([\s\S]*?);/gi;
    for (let match = alterTable.exec(sql); match; match = alterTable.exec(sql)) {
      if ((match[1] ?? "public") !== "public" || !/references\s+auth\.users/i.test(match[3])) {
        continue;
      }
      for (const item of splitTopLevel(match[3])) {
        const column =
          /add\s+column\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?[\s\S]*?references\s+auth\.users/i.exec(
            item,
          );
        if (column) addKey(match[2], column[1], item);
        const constraint = /foreign\s+key\s*\(\s*"?(\w+)"?\s*\)\s*references\s+auth\.users/i.exec(
          item,
        );
        if (constraint) addKey(match[2], constraint[1], item);
      }
    }

    const dropTable = /drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?(\w+)"?/gi;
    for (let match = dropTable.exec(sql); match; match = dropTable.exec(sql)) dropped.add(match[1]);
  }

  for (const table of dropped) tables.delete(table);
  return {
    foreignKeys: [...foreignKeys.values()].filter((key) => tables.has(key.table)),
    tables,
  };
}

const schema = readSchema();
const erased = new Set(ERASURE_TABLES.map(([table]) => table));

describe("ERASURE_TABLES face au schéma", () => {
  it("lit des clés étrangères vers auth.users dans les migrations", () => {
    // Garde-fou du lecteur : s'il ne trouve plus rien, les autres vérifications ne prouvent rien.
    expect(schema.foreignKeys.length).toBeGreaterThan(40);
    expect(schema.foreignKeys.some((key) => key.table === "user_favorites")).toBe(true);
  });

  it("n'a ni doublon ni table inconnue des migrations", () => {
    const keys = ERASURE_TABLES.map(([table, column]) => `${table}.${column}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(ERASURE_TABLES.filter(([table]) => !schema.tables.has(table))).toEqual([]);
  });

  it("couvre chaque colonne en cascade vers auth.users, sauf cascade seule déclarée", () => {
    const cascaded = schema.foreignKeys.filter((key) => key.onDelete === "cascade");
    const listed = new Set(ERASURE_TABLES.map(([table, column]) => `${table}.${column}`));
    const missing = cascaded
      .filter((key) => !listed.has(`${key.table}.${key.column}`) && !(key.table in CASCADE_ONLY))
      .map((key) => `${key.table}.${key.column}`);
    expect(missing).toEqual([]);
  });

  it("nomme chaque cascade seule déclarée : elle existe, et n'est pas déjà effacée explicitement", () => {
    for (const table of Object.keys(CASCADE_ONLY)) {
      expect(
        schema.foreignKeys.some((key) => key.table === table && key.onDelete === "cascade"),
      ).toBe(true);
      expect(erased.has(table)).toBe(false);
    }
  });

  it("cite les journaux de mesure et de rappels, liés au compte", () => {
    expect(ERASURE_TABLES).toContainEqual(["account_product_events", "user_id"]);
    expect(ERASURE_TABLES).toContainEqual(["sale_signal_feedback", "user_id"]);
    expect(ERASURE_TABLES).toContainEqual(["sale_reminder_dispatches", "user_id"]);
    expect(ERASURE_TABLES).toContainEqual(["weekly_digest_dispatches", "user_id"]);
    expect(ERASURE_TABLES).toContainEqual(["sale_result_dispatches", "user_id"]);
  });

  it("n'efface pas les traces que la loi oblige à garder", () => {
    for (const table of RETAINED_TABLES) {
      expect(erased.has(table)).toBe(false);
      expect(
        schema.foreignKeys.some((key) => key.table === table && key.onDelete === "set null"),
      ).toBe(true);
    }
  });
});
