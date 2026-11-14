import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeOperationalAlert } from "./operational-alert-labels";

/**
 * La table des libellés ne doit pas dériver des migrations : toute clé d'alerte écrite en littéral par une
 * migration (clé entière ou préfixe d'une famille) reçoit un libellé propre, jamais le repli
 * « … non répertoriée ».
 */
const MIGRATIONS_DIR = join(process.cwd(), "supabase/migrations");
const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .map((name) => readFileSync(join(MIGRATIONS_DIR, name), "utf8"));

/** Clés entières et préfixes (suivis de `||`) passés aux écritures d'alertes. */
function alertKeysFromMigrations() {
  const keys = new Set<string>();
  const prefixes = new Set<string>();
  const patterns = [
    /sync_operational_alert\(\s*'([a-z0-9_.]+)'(\s*\|\|)?/g,
    /v_alert_key\s*:=\s*'([a-z0-9_.]+)'(\s*\|\|)?/g,
    /insert into public\.operational_alerts\s*\([^)]*\)\s*values\s*\(\s*'([a-z0-9_.]+)'()/g,
  ];
  for (const sql of migrations) {
    for (const pattern of patterns) {
      for (const match of sql.matchAll(pattern)) {
        (match[2] ? prefixes : keys).add(match[1]);
      }
    }
  }
  return { keys: [...keys].sort(), prefixes: [...prefixes].sort() };
}

const FALLBACK = /non répertoriée/;

describe("operational alert labels stay in step with the migrations", () => {
  const { keys, prefixes } = alertKeysFromMigrations();

  it("finds the alert keys written by the migrations", () => {
    expect(keys).toContain("pipeline.enrichment.stalled");
    expect(keys).toContain("information_agent.unrouted.pending");
    expect(prefixes).toContain("pipeline.source.");
    expect(prefixes).toContain("fact_registry.");
  });

  it.each(keys)("labels the key %s", (key) => {
    expect(describeOperationalAlert(key).label).not.toMatch(FALLBACK);
  });

  it.each(prefixes)("labels the family %s", (prefix) => {
    expect(describeOperationalAlert(`${prefix}controle_inconnu`).label).not.toMatch(FALLBACK);
  });

  it("names every fact registry check planned by the migrations", () => {
    const checks = new Set<string>();
    for (const sql of migrations) {
      const block = /values\s*([\s\S]*?)\)\s*as planned \(check_key, severity\)/.exec(sql)?.[1];
      for (const match of block?.matchAll(/\('([a-z0-9_]+)',\s*'(?:critical|warning)'\)/g) ?? []) {
        checks.add(match[1]);
      }
    }
    expect(checks.size).toBeGreaterThanOrEqual(13);
    for (const check of checks) {
      expect(describeOperationalAlert(`fact_registry.${check}`).label).toMatch(
        /^Registre des pièces : /,
      );
    }
  });

  it("names every warning code the autopilot can raise", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/information-agent-autopilot.ts"),
      "utf8",
    );
    const list = /const KNOWN_WARNINGS = \[([\s\S]*?)\]/.exec(source)?.[1] ?? "";
    const codes = [...list.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      expect(describeOperationalAlert(`information_agent.autopilot.warning.${code}`).label).toMatch(
        /^Pilote de l’Agent IA proche d’un seuil d’arrêt : /,
      );
    }
  });
});
