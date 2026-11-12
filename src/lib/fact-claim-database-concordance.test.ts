import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FACT_CLAIM_DATABASE_ERROR_CODES } from "./fact-claim-database-errors";
import {
  FACT_CLAIM_LOT_ATTACHMENTS,
  FACT_CLAIM_REJECT_REASONS,
  FACT_CLAIM_RESERVED_EVIDENCE_KINDS,
  FACT_CLAIM_WITHDRAW_REASONS,
} from "./fact-claim-decisions";

/**
 * Concordance entre les listes fermées de la base (migrations du registre des pièces) et leurs
 * copies côté application. Les migrations sont lues telles quelles : une liste modifiée en base
 * sans sa copie fait échouer ce test, et inversement.
 */
const MIGRATIONS = join(process.cwd(), "supabase/migrations");
const FIRST_REGISTRY_MIGRATION = "20261116100000";

/**
 * Codes traduits par l'application mais que la base ne lève pas encore sur cette branche.
 * `decision_in_progress` : annoncé par la partie base du lot R2c, levé par une migration
 * `20261119…`. Le garder ici après son arrivée ne casse rien ; l'en retirer alors.
 */
const ANNOUNCED_CODES = ["decision_in_progress"];

/** Fonctions dont les refus arrivent aux routes de décision. */
const DECISION_FUNCTIONS =
  /create or replace function (?:app_private\.(?:decide_auction_fact_claim|lock_sale_for_registry)|public\.(?:accept|reject|withdraw|oppose)_auction_fact_claim)\b/;

function withoutComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

function registryMigrations(): Array<{ name: string; sql: string }> {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql") && name >= FIRST_REGISTRY_MIGRATION)
    .sort()
    .map((name) => ({ name, sql: withoutComments(readFileSync(join(MIGRATIONS, name), "utf8")) }));
}

/** Tout code que les migrations des fonctions de décision peuvent lever (message = code). */
function databaseRefusalCodes(): string[] {
  const codes = new Set<string>();
  for (const { sql } of registryMigrations().filter(({ sql }) => DECISION_FUNCTIONS.test(sql))) {
    for (const [, code] of sql.matchAll(/message = '([a-z_]+)'/g)) codes.add(code);
    for (const [, code] of sql.matchAll(/v_refusal := '([a-z_]+)'/g)) codes.add(code);
    for (const [block] of sql.matchAll(/v_refusal := case[\s\S]*?end;/g)) {
      for (const [, code] of block.matchAll(/(?:then|else) '([a-z_]+)'/g)) codes.add(code);
    }
  }
  return [...codes].sort();
}

function quoted(list: string): string[] {
  return [...list.matchAll(/'([a-z_]+)'/g)].map(([, value]) => value).sort();
}

function tablesMigration(): string {
  return withoutComments(
    readFileSync(join(MIGRATIONS, "20261116100000_fact_registry_tables.sql"), "utf8"),
  );
}

const sortedKeys = (record: Record<string, unknown>) => Object.keys(record).sort();

describe("concordance avec la base : codes de refus des décisions", () => {
  it("lit bien les fonctions de décision", () => {
    const codes = databaseRefusalCodes();
    expect(codes.length).toBeGreaterThanOrEqual(19);
    expect(codes).toContain("sale_busy");
    expect(codes).toContain("withdrawal_final");
    expect(codes).toContain("sale_not_found");
  });

  it("traduit chaque code que la base lève, et rien d'autre que les codes annoncés", () => {
    const database = databaseRefusalCodes();
    expect(sortedKeys(FACT_CLAIM_DATABASE_ERROR_CODES)).toEqual(
      [...new Set([...database, ...ANNOUNCED_CODES])].sort(),
    );
  });
});

describe("concordance avec la base : listes fermées", () => {
  const reasons = (decision: string) => {
    const match = new RegExp(
      `when '${decision}' then coalesce\\(\\s*reason_code in \\(([^)]*)\\)`,
    ).exec(tablesMigration());
    return quoted(match?.[1] ?? "");
  };

  it("motifs de rejet", () => {
    expect(reasons("rejected")).toEqual(sortedKeys(FACT_CLAIM_REJECT_REASONS));
  });

  it("motifs de retrait", () => {
    expect(reasons("withdrawn")).toEqual(sortedKeys(FACT_CLAIM_WITHDRAW_REASONS));
  });

  it("rattachements au lot", () => {
    const match = /lot_attachment in \(([^)]*)\)/.exec(tablesMigration());
    expect(quoted(match?.[1] ?? "")).toEqual(sortedKeys(FACT_CLAIM_LOT_ATTACHMENTS));
  });

  it("natures d'observation réservées au registre (garde d'origine)", () => {
    const guards = registryMigrations().flatMap(({ sql }) =>
      [...sql.matchAll(/when \(new\.evidence_kind in \(([^)]*)\)\)/g)].map(([, list]) =>
        quoted(list),
      ),
    );
    expect(guards.length).toBeGreaterThan(0);
    expect(guards[0]).toEqual(sortedKeys(FACT_CLAIM_RESERVED_EVIDENCE_KINDS));
  });
});
