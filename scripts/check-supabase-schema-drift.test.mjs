import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DIFF_TOOL_FAILURE_TAIL_CHARACTERS,
  DIFF_TOOL_FAILURE_TAIL_LINES,
  RECONCILED_CHECK_CONSTRAINTS,
  diffToolFailureReport,
  quoteForeignText,
  canonicalCheckCondition,
  canonicalConcurrentIndexDefinition,
  checkBody,
  normalizeConcurrentIndexDefinition,
  normalizeDiff,
  TRANSIENT_RETRY_DELAYS_SECONDS,
  isTransientConnectionFailure,
  normalizeDiffWithNotes,
  runWithTransientRetry,
  verifyConcurrentIndexes,
} from "./lib/schema-drift.mjs";

// Body of the `(...)` that opens at `openIndex`, quotes respected.
function balancedBody(sql, openIndex) {
  let depth = 0;
  let quoted = false;
  for (let index = openIndex; index < sql.length; index += 1) {
    const character = sql[index];
    if (quoted) {
      if (character === "'") {
        if (sql[index + 1] === "'") index += 1;
        else quoted = false;
      }
    } else if (character === "'") quoted = true;
    else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return sql.slice(openIndex + 1, index);
    }
  }
  throw new Error("Unbalanced parentheses in migration SQL.");
}

// Condition of the CHECK constraint `name` defined by one migration, either as
// `constraint <name> check (...)` or inline on the column of the table's
// `create table` (PostgreSQL auto-name `<table>_<column>_check`). Null if none.
function checkConditionFromMigration(source, tableName, name) {
  const sql = source.replace(/--[^\n]*/g, "");
  const named = new RegExp(`\\bconstraint\\s+${name}\\s+check\\s*\\(`, "i").exec(sql);
  if (named) return balancedBody(sql, named.index + named[0].length - 1);

  const created = new RegExp(
    `create table (?:if not exists )?(?:public\\.)?${tableName}\\s*\\(`,
    "i",
  ).exec(sql);
  if (!created) return null;
  const rest = sql.slice(created.index + created[0].length);
  const next = rest.search(/create table/i);
  const block = next === -1 ? rest : rest.slice(0, next);
  const column = name.slice(tableName.length + 1, -"_check".length);
  const inline = new RegExp(`^\\s*${column}\\s[^\\n]*?\\bcheck\\s*\\(`, "im").exec(block);
  return inline ? balancedBody(block, inline.index + inline[0].length - 1) : null;
}

const normalizeEscapeStrings = (condition) =>
  condition.replace(/\bE'((?:[^']|'')*)'/g, (_match, body) => `'${body.replaceAll("\\\\", "\\")}'`);

// `x BETWEEN a AND b` is stored by Postgres as `x >= a AND x <= b`.
const expandBetween = (condition) =>
  condition.replace(
    /([\w.]+(?:\((?:[^()]|\([^()]*\))*\))?)\s+between\s+(-?\d+)\s+and\s+(-?\d+)/gi,
    "$1 >= $2 AND $1 <= $3",
  );

const migrationsDirectory = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "supabase",
  "migrations",
);

describe("Supabase schema drift normalization", () => {
  it("ignores the four exact reviewed concurrent-index definitions", () => {
    expect(
      normalizeDiff(`
CREATE INDEX auction_collection_items_run_source_url_idx ON public.auction_collection_items (run_id, source_url);
CREATE INDEX auction_collection_items_run_canonical_source_url_idx ON public.auction_collection_items (run_id, canonical_source_url);
CREATE INDEX auction_sales_postal_code_idx ON public.auction_sales (postal_code);
CREATE INDEX auction_sales_source_urls_gin_idx ON public.auction_sales USING gin (source_urls);
`),
    ).toBe("");
  });

  it("ignores the exact reviewed DVF commune market index and nothing close to it", () => {
    expect(
      normalizeDiff(
        "CREATE INDEX dvf_transactions_insee_type_sale_date_idx ON public.dvf_transactions (insee_code, property_type, sale_date);",
      ),
    ).toBe("");
    expect(
      normalizeDiff(
        "CREATE INDEX dvf_transactions_insee_type_sale_date_idx ON public.dvf_transactions (insee_code, sale_date);",
      ),
    ).toContain("dvf_transactions_insee_type_sale_date_idx");
  });

  describe("fact registry indexes (partial, expression, unique)", () => {
    // Formes possibles de l'outil de diff pour un même index : avec ou sans « USING btree », avec ou sans
    // parenthèses autour du prédicat, avec ou sans transtypage ::text des constantes.
    it.each([
      "CREATE INDEX auction_sales_held_fields_idx ON public.auction_sales (id) WHERE (held_fields IS NOT NULL);",
      "CREATE INDEX auction_sales_held_fields_idx ON public.auction_sales USING btree (id) WHERE (held_fields IS NOT NULL);",
      "CREATE INDEX auction_sales_held_fields_idx ON public.auction_sales (id) WHERE held_fields IS NOT NULL;",
      "CREATE UNIQUE INDEX auction_fact_claims_agent_fact_key ON public.auction_fact_claims (((evidence_locator ->> 'information_agent_fact_id'::text))) WHERE (evidence_locator ? 'information_agent_fact_id'::text);",
      "CREATE UNIQUE INDEX auction_fact_claims_agent_fact_key ON public.auction_fact_claims USING btree (((evidence_locator ->> 'information_agent_fact_id'::text))) WHERE (evidence_locator ? 'information_agent_fact_id'::text);",
      "CREATE UNIQUE INDEX auction_fact_claims_agent_fact_key ON public.auction_fact_claims ((evidence_locator ->> 'information_agent_fact_id')) WHERE evidence_locator ? 'information_agent_fact_id';",
    ])("ignores the reviewed definition however it is printed: %s", (line) => {
      expect(normalizeDiff(line)).toBe("");
    });

    it.each([
      [
        "another predicate",
        "CREATE INDEX auction_sales_held_fields_idx ON public.auction_sales (id) WHERE (held_fields IS NULL);",
      ],
      ["no predicate", "CREATE INDEX auction_sales_held_fields_idx ON public.auction_sales (id);"],
      [
        "another column",
        "CREATE INDEX auction_sales_held_fields_idx ON public.auction_sales (source_url) WHERE (held_fields IS NOT NULL);",
      ],
      [
        "unique where it must not be",
        "CREATE UNIQUE INDEX auction_sales_held_fields_idx ON public.auction_sales (id) WHERE (held_fields IS NOT NULL);",
      ],
      [
        "another access method",
        "CREATE INDEX auction_sales_held_fields_idx ON public.auction_sales USING hash (id) WHERE (held_fields IS NOT NULL);",
      ],
      [
        "not unique where it must be",
        "CREATE INDEX auction_fact_claims_agent_fact_key ON public.auction_fact_claims (((evidence_locator ->> 'information_agent_fact_id'::text))) WHERE (evidence_locator ? 'information_agent_fact_id'::text);",
      ],
      [
        "another expression",
        "CREATE UNIQUE INDEX auction_fact_claims_agent_fact_key ON public.auction_fact_claims (((evidence_locator ->> 'case_id'::text))) WHERE (evidence_locator ? 'information_agent_fact_id'::text);",
      ],
      [
        "another table",
        "CREATE UNIQUE INDEX auction_fact_claims_agent_fact_key ON public.auction_sales (((evidence_locator ->> 'information_agent_fact_id'::text))) WHERE (evidence_locator ? 'information_agent_fact_id'::text);",
      ],
      // Two forms that a canonical form dropping every `::text` and every parenthesis would hide.
      [
        "the column cast to text",
        "CREATE INDEX auction_sales_held_fields_idx ON public.auction_sales (((id)::text)) WHERE (held_fields IS NOT NULL);",
      ],
      [
        "the predicate column cast to text",
        "CREATE INDEX auction_sales_held_fields_idx ON public.auction_sales (id) WHERE ((held_fields)::text IS NOT NULL);",
      ],
      [
        "the expression cast to another type than the reviewed one",
        "CREATE UNIQUE INDEX auction_fact_claims_agent_fact_key ON public.auction_fact_claims ((((evidence_locator ->> 'information_agent_fact_id'::text))::text)) WHERE (evidence_locator ? 'information_agent_fact_id'::text);",
      ],
    ])("keeps a fact registry index with %s in the diff", (_label, line) => {
      expect(normalizeDiff(line)).toBe(line);
    });

    // Production, 12/11/2026 08:50 UTC (workflow « Apply Supabase Migrations », lot R2a) : l'outil a imprimé
    // chaque index sur DEUX lignes, le WHERE à part et indenté. Texte exact du journal.
    const run20261112 = `CREATE UNIQUE INDEX auction_fact_claims_agent_fact_key ON public.auction_fact_claims ((evidence_locator ->> 'information_agent_fact_id'::text))
  WHERE evidence_locator ? 'information_agent_fact_id'::text;
CREATE INDEX auction_sales_held_fields_idx ON public.auction_sales (id)
  WHERE held_fields IS NOT NULL;`;

    it("ignores the two reviewed indexes printed on two lines each (production, 12/11/2026)", () => {
      expect(normalizeDiff(run20261112)).toBe("");
      expect(normalizeDiff(run20261112.replaceAll("\n", "\r\n"))).toBe("");
      // Sous les lignes d'en-tête de l'outil, qui ne finissent pas par un point-virgule.
      expect(
        normalizeDiff(
          `-- Migration unit 1: 20261117100450_fact_registry_concurrent_indexes.sql\n\n${run20261112}\n`,
        ),
      ).toBe("");
    });

    it("removes only the reviewed statement and keeps its neighbours", () => {
      expect(
        normalizeDiff(
          `ALTER TABLE public.auction_sales ADD COLUMN extra text;\n${run20261112}\nDROP TABLE public.auction_fact_claims;`,
        ),
      ).toBe(
        "ALTER TABLE public.auction_sales ADD COLUMN extra text;\nDROP TABLE public.auction_fact_claims;",
      );
    });

    it.each([
      [
        "an index outside the allowlist",
        "CREATE INDEX unreviewed_extra_idx ON public.auction_sales (id)\n  WHERE held_fields IS NOT NULL;",
      ],
      [
        "another index name",
        "CREATE INDEX auction_sales_held_fields_v2_idx ON public.auction_sales (id)\n  WHERE held_fields IS NOT NULL;",
      ],
      [
        "another table",
        "CREATE INDEX auction_sales_held_fields_idx ON public.auction_fact_claims (id)\n  WHERE held_fields IS NOT NULL;",
      ],
      [
        "unique where it must not be",
        "CREATE UNIQUE INDEX auction_sales_held_fields_idx ON public.auction_sales (id)\n  WHERE held_fields IS NOT NULL;",
      ],
      [
        "not unique where it must be",
        "CREATE INDEX auction_fact_claims_agent_fact_key ON public.auction_fact_claims ((evidence_locator ->> 'information_agent_fact_id'::text))\n  WHERE evidence_locator ? 'information_agent_fact_id'::text;",
      ],
      [
        "another column",
        "CREATE INDEX auction_sales_held_fields_idx ON public.auction_sales (source_url)\n  WHERE held_fields IS NOT NULL;",
      ],
      [
        "another operator in the expression",
        "CREATE UNIQUE INDEX auction_fact_claims_agent_fact_key ON public.auction_fact_claims ((evidence_locator -> 'information_agent_fact_id'::text))\n  WHERE evidence_locator ? 'information_agent_fact_id'::text;",
      ],
      [
        "another operator in the predicate",
        "CREATE INDEX auction_sales_held_fields_idx ON public.auction_sales (id)\n  WHERE held_fields IS NULL;",
      ],
      [
        "another constant",
        "CREATE UNIQUE INDEX auction_fact_claims_agent_fact_key ON public.auction_fact_claims ((evidence_locator ->> 'information_agent_fact_id'::text))\n  WHERE evidence_locator ? 'case_id'::text;",
      ],
      [
        "no predicate line",
        "CREATE INDEX auction_sales_held_fields_idx ON public.auction_sales (id)\n  ;",
      ],
      [
        "one more predicate line",
        "CREATE INDEX auction_sales_held_fields_idx ON public.auction_sales (id)\n  WHERE held_fields IS NOT NULL\n  AND id IS NOT NULL;",
      ],
      [
        "no terminator before the next statement",
        "CREATE INDEX auction_sales_held_fields_idx ON public.auction_sales (id)\n  WHERE held_fields IS NOT NULL\nDROP TABLE public.auction_fact_claims;",
      ],
      [
        "a comment between its two lines",
        "CREATE INDEX auction_sales_held_fields_idx ON public.auction_sales (id)\n  -- WHERE held_fields IS NULL\n  WHERE held_fields IS NOT NULL;",
      ],
      [
        "another statement before it on its first line",
        "DROP TABLE public.x; CREATE INDEX auction_sales_held_fields_idx ON public.auction_sales (id)\n  WHERE held_fields IS NOT NULL;",
      ],
      [
        "another statement after it on its last line",
        "CREATE INDEX auction_sales_held_fields_idx ON public.auction_sales (id)\n  WHERE held_fields IS NOT NULL; DROP TABLE public.x;",
      ],
      // Une constante entre apostrophes est une donnée : ni casse, ni contenu réécrits.
      [
        "a constant in another case",
        "CREATE UNIQUE INDEX auction_fact_claims_agent_fact_key ON public.auction_fact_claims ((evidence_locator ->> 'information_agent_fact_id'::text))\n  WHERE evidence_locator ? 'Information_Agent_Fact_ID'::text;",
      ],
      [
        "a constant that holds USING btree",
        "CREATE UNIQUE INDEX auction_fact_claims_agent_fact_key ON public.auction_fact_claims ((evidence_locator ->> 'information_agent_fact_id using btree'::text))\n  WHERE evidence_locator ? 'information_agent_fact_id'::text;",
      ],
      [
        "a constant that holds parentheses",
        "CREATE UNIQUE INDEX auction_fact_claims_agent_fact_key ON public.auction_fact_claims ((evidence_locator ->> '(information_agent_fact_id)'::text))\n  WHERE evidence_locator ? 'information_agent_fact_id'::text;",
      ],
      [
        "a constant that holds a quoted identifier",
        "CREATE UNIQUE INDEX auction_fact_claims_agent_fact_key ON public.auction_fact_claims ((evidence_locator ->> '\"information_agent_fact_id\"'::text))\n  WHERE evidence_locator ? 'information_agent_fact_id'::text;",
      ],
      [
        "a constant that holds its own cast",
        "CREATE UNIQUE INDEX auction_fact_claims_agent_fact_key ON public.auction_fact_claims ((evidence_locator ->> 'information_agent_fact_id''::text'))\n  WHERE evidence_locator ? 'information_agent_fact_id'::text;",
      ],
      [
        "an unterminated index before it",
        "CREATE INDEX unreviewed_extra_idx ON public.auction_sales (postal_code)\nCREATE INDEX auction_sales_held_fields_idx ON public.auction_sales (id)\n  WHERE held_fields IS NOT NULL;",
      ],
    ])("keeps a two-line index with %s in the diff", (_label, statement) => {
      expect(normalizeDiff(statement)).toBe(statement);
    });

    it.each([
      [
        "ALTER TABLE",
        "ALTER TABLE public.auction_sales\n  ADD COLUMN auction_sales_held_fields_idx text;",
      ],
      ["DROP INDEX", "DROP INDEX\n  public.auction_sales_held_fields_idx;"],
      [
        "CREATE POLICY",
        "CREATE POLICY held_fields_read ON public.auction_sales\n  USING (held_fields IS NOT NULL);",
      ],
      [
        "COMMENT that quotes the reviewed index",
        "COMMENT ON TABLE public.auction_sales IS 'see\nCREATE INDEX auction_sales_held_fields_idx ON public.auction_sales (id)\n  WHERE held_fields IS NOT NULL';",
      ],
    ])("keeps a multi-line %s statement in the diff", (_label, statement) => {
      expect(normalizeDiff(statement)).toBe(statement);
    });

    it("leaves a reviewed index printed without its semicolon in the diff", () => {
      const withoutSemicolon =
        "CREATE INDEX auction_sales_postal_code_idx ON public.auction_sales (postal_code)";
      expect(normalizeDiff(`${withoutSemicolon};`)).toBe("");
      expect(normalizeDiff(withoutSemicolon)).toBe(withoutSemicolon);
      expect(normalizeDiff(`${withoutSemicolon}\n${withoutSemicolon}`)).toBe(
        `${withoutSemicolon}\n${withoutSemicolon}`,
      );
    });

    it("reads a long diff without any semicolon in a time proportional to its length", () => {
      // 60 000 index lines, 3 Mo, aucun point-virgule : une recherche qui repart de chaque ligne jusqu'à
      // la fin du texte y passe plus d'une minute.
      const text = Array.from(
        { length: 60_000 },
        (_unused, index) => `CREATE INDEX unreviewed_${index}_idx ON public.auction_sales (id)`,
      ).join("\n");
      const started = performance.now();
      expect(normalizeDiff(text)).toBe(text);
      expect(performance.now() - started).toBeLessThan(2000);
    });

    it("does not loosen the match of the earlier operations", () => {
      // La forme canonique (parenthèses, ::text, USING btree ignorés) ne vaut que pour les deux index ci-dessus.
      expect(
        normalizeDiff(
          "CREATE INDEX auction_sales_postal_code_idx ON public.auction_sales USING btree (postal_code);",
        ),
      ).toContain("auction_sales_postal_code_idx");
      expect(
        canonicalConcurrentIndexDefinition(
          'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "auction_fact_claims_agent_fact_key" ON "public"."auction_fact_claims" (("evidence_locator" ->> \'information_agent_fact_id\')) WHERE ("evidence_locator" ? \'information_agent_fact_id\');',
        ),
      ).toBe(
        "create unique index auction_fact_claims_agent_fact_key on public.auction_fact_claims evidence_locator ->> 'information_agent_fact_id' where evidence_locator ? 'information_agent_fact_id'",
      );
    });
  });

  it("keeps altered definitions and indexes outside the allowlist", () => {
    expect(
      normalizeDiff(
        "CREATE INDEX auction_sales_source_urls_gin_idx ON public.auction_sales (source_urls);",
      ),
    ).toContain("auction_sales_source_urls_gin_idx");
    expect(
      normalizeDiff(
        "CREATE INDEX auction_collection_items_run_source_url_idx ON public.auction_collection_items (source_url, run_id);",
      ),
    ).toContain("source_url, run_id");
    expect(
      normalizeDiff("CREATE INDEX unreviewed_extra_idx ON public.auction_sales (postal_code);"),
    ).toContain("unreviewed_extra_idx");
    expect(
      normalizeDiff(
        'CREATE INDEX "AUCTION_SALES_POSTAL_CODE_IDX" ON public.auction_sales (postal_code);',
      ),
    ).toContain('"AUCTION_SALES_POSTAL_CODE_IDX"');
    expect(
      normalizeDiff(
        'CREATE INDEX auction_sales_postal_code_idx ON public.auction_sales ("Postal_Code");',
      ),
    ).toContain('"Postal_Code"');
  });

  it("normalizes the runner syntax without reducing the match to an index name", () => {
    expect(
      normalizeConcurrentIndexDefinition(
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "auction_sales_source_urls_gin_idx" ON "public"."auction_sales" USING GIN ("source_urls");',
      ),
    ).toBe(
      "create index auction_sales_source_urls_gin_idx on public.auction_sales using gin (source_urls)",
    );
  });

  // Le rôle `lovable_readonly` est supprimé par la migration 20261117110000 : plus aucune ligne qui le nomme
  // n'est ignorée, pas même les droits de lecture que le contrôle laissait passer tant qu'il existait.
  it.each([
    "GRANT SELECT ON TABLE public.auction_sales TO lovable_readonly;",
    'GRANT SELECT ON TABLE public.auction_sales TO "lovable_readonly";',
    "GRANT SELECT (id, city) ON TABLE public.auction_sales TO lovable_readonly;",
    "REVOKE SELECT ON TABLE public.auction_sales FROM lovable_readonly;",
    "GRANT EXECUTE ON FUNCTION app_private.public_sale_conditions(jsonb) TO lovable_readonly;",
    "GRANT USAGE ON SCHEMA public TO lovable_readonly;",
    "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO lovable_readonly;",
    "GRANT lovable_readonly TO postgres;",
  ])("reports %s as drift", (line) => {
    expect(normalizeDiff(line)).toBe(line);
  });

  it("preserves the existing platform-managed drift filters", () => {
    expect(
      normalizeDiff(`
CREATE EXTENSION pg_net WITH SCHEMA public;
-- Migration unit 2: 20261008121940_hot_identity_and_collection_lookup_indexes.sql
-- Transaction mode: non-transactional
-- Boundary reason: CREATE INDEX CONCURRENTLY
SET check_function_bodies = false;
`),
    ).toBe("");
  });

  describe("reconciled BETWEEN-led CHECK constraints (run 79)", () => {
    const sourceUrlDrop =
      "ALTER TABLE public.auction_ai_review_case_status DROP CONSTRAINT auction_ai_review_case_status_source_url_check;";
    const sourceUrlAdd =
      "ALTER TABLE public.auction_ai_review_case_status ADD CONSTRAINT auction_ai_review_case_status_source_url_check CHECK (char_length(source_url) >= 1 AND char_length(source_url) <= 4096 AND source_url ~ '^https://'::text);";

    it("ignores the DROP + ADD pair when production holds the migration definition", () => {
      expect(normalizeDiff(`${sourceUrlDrop}\n${sourceUrlAdd}\n`)).toBe("");
    });

    it("tolerates parentheses, nesting, casts and wrapped lines in the production text", () => {
      expect(
        normalizeDiff(`
${sourceUrlDrop}
ALTER TABLE public.auction_ai_review_case_status
  ADD CONSTRAINT auction_ai_review_case_status_source_url_check
  CHECK ((((char_length(source_url) >= 1) AND (char_length(source_url) <= 4096)) AND (source_url ~ '^https://'::text)));
`),
      ).toBe("");
    });

    const pinned = (name) =>
      RECONCILED_CHECK_CONSTRAINTS.find((constraint) => constraint.name === name);
    const pairFor = ({ table, name }, definition) =>
      `ALTER TABLE ${table} DROP CONSTRAINT ${name};\nALTER TABLE ${table} ADD CONSTRAINT ${name} ${definition};`;

    it("ignores every pinned constraint with its exact production definition", () => {
      const diff = RECONCILED_CHECK_CONSTRAINTS.map((constraint) =>
        pairFor(constraint, constraint.productionDefinition),
      ).join("\n");
      expect(RECONCILED_CHECK_CONSTRAINTS).toHaveLength(12);
      expect(normalizeDiff(diff)).toBe("");
    });

    it("accepts the nested Postgres 17.6 BETWEEN form against the 17.11 pin (no OR)", () => {
      const constraint = pinned("auction_ai_review_projections_source_url_check");
      expect(constraint.productionDefinition).toBe(
        "CHECK (((char_length(source_url) >= 1) AND (char_length(source_url) <= 4096) AND (source_url ~ '^https://'::text)))",
      );
      const nested =
        "CHECK ((((char_length(source_url) >= 1) AND (char_length(source_url) <= 4096)) AND (source_url ~ '^https://'::text)))";
      expect(normalizeDiff(pairFor(constraint, nested))).toBe("");
      const nestedAltered = nested.replace("<= 4096", "<= 4097");
      expect(normalizeDiff(pairFor(constraint, nestedAltered))).toContain("<= 4097");
    });

    it("accepts the nested Postgres 17.6 BETWEEN form against the 17.11 pin (with OR)", () => {
      const constraint = pinned("information_agent_missions_reply_to_email_check");
      const nested = String.raw`CHECK (((reply_to_email IS NULL) OR (((char_length(reply_to_email) >= 3) AND (char_length(reply_to_email) <= 320)) AND (reply_to_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'::text))))`;
      expect(normalizeDiff(pairFor(constraint, nested))).toBe("");
      // Same atoms, regrouped: the OR no longer wraps the whole conjunction.
      const regrouped = String.raw`CHECK ((((reply_to_email IS NULL) OR ((char_length(reply_to_email) >= 3) AND (char_length(reply_to_email) <= 320))) AND (reply_to_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'::text)))`;
      expect(normalizeDiff(pairFor(constraint, regrouped))).toContain("ADD CONSTRAINT");
    });

    it("keeps the pair when the production definition is loosened or changed", () => {
      const loosened = sourceUrlAdd.replace("<= 4096", "<= 8192");
      expect(normalizeDiff(`${sourceUrlDrop}\n${loosened}`)).toContain("<= 8192");
      const noScheme = sourceUrlAdd.replace("'^https://'", "'^http://'");
      expect(normalizeDiff(`${sourceUrlDrop}\n${noScheme}`)).toContain("^http://");
      const dropped = sourceUrlAdd.replace(" AND source_url ~ '^https://'::text", "");
      expect(normalizeDiff(`${sourceUrlDrop}\n${dropped}`)).toContain("ADD CONSTRAINT");
    });

    it("keeps an unpaired DROP, an unpaired ADD and unlisted constraints", () => {
      expect(normalizeDiff(sourceUrlDrop)).toContain("DROP CONSTRAINT");
      expect(normalizeDiff(sourceUrlAdd)).toContain("ADD CONSTRAINT");
      expect(
        normalizeDiff(
          "ALTER TABLE public.auction_sales DROP CONSTRAINT auction_sales_other_check;\nALTER TABLE public.auction_sales ADD CONSTRAINT auction_sales_other_check CHECK (char_length(source_url) >= 1);",
        ),
      ).toContain("auction_sales_other_check");
    });

    it("does not equate different OR/AND groupings", () => {
      expect(canonicalCheckCondition("(a IS NULL OR b) AND c")).not.toBe(
        canonicalCheckCondition("a IS NULL OR (b AND c)"),
      );
      expect(canonicalCheckCondition("(a AND b) AND c")).toBe(
        canonicalCheckCondition("a AND b AND c"),
      );
      expect(canonicalCheckCondition("x ~ '^A$'::text")).not.toBe(
        canonicalCheckCondition("x ~ '^a$'::text"),
      );
    });

    it("reads the implicit SQL precedence of the unparenthesised pg-delta text", () => {
      expect(canonicalCheckCondition("a IS NULL OR b >= 1 AND c <= 2 AND d IS NOT NULL")).toBe(
        canonicalCheckCondition("((a IS NULL) OR ((b >= 1) AND (c <= 2) AND (d IS NOT NULL)))"),
      );
      expect(canonicalCheckCondition("a IS NULL OR b >= 1 AND c <= 2")).not.toBe(
        canonicalCheckCondition("(a IS NULL OR b >= 1) AND c <= 2"),
      );
    });

    it("filters the real pg-delta layout of run 79 and keeps only the backup table", () => {
      // Verbatim excerpt of the run 79 log: ALTER TABLE and the action are on two
      // lines, the ADD is wrapped, and parentheses follow the implicit precedence.
      const run79 = String.raw`ALTER TABLE public.auction_ai_review_case_status
  DROP CONSTRAINT auction_ai_review_case_status_source_url_check;
ALTER TABLE public.auction_fact_claims
  DROP CONSTRAINT auction_fact_claims_conflict_group_check;
ALTER TABLE public.information_agent_cases
  DROP CONSTRAINT information_agent_cases_recipient_email_check;
ALTER TABLE app_private.cessions_point_parcels_backup_20261011
  ALTER COLUMN confidence DROP NOT NULL;
ALTER TABLE public.auction_ai_review_case_status
  ADD CONSTRAINT auction_ai_review_case_status_source_url_check CHECK (char_length(source_url) >= 1 AND char_length(source_url) <= 4096 AND source_url ~ '^https://'::text);
ALTER TABLE public.auction_fact_claims
  ADD CONSTRAINT auction_fact_claims_conflict_group_check
    CHECK (conflict_group IS NULL OR char_length(conflict_group) >= 1 AND char_length(conflict_group) <= 200 AND NULLIF(btrim(conflict_group), ''::text) IS NOT NULL);
ALTER TABLE public.information_agent_cases
  ADD CONSTRAINT information_agent_cases_recipient_email_check
    CHECK
    (char_length(recipient_email) >= 3 AND char_length(recipient_email) <= 320 AND recipient_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'::text AND
    normalized_recipient_email = lower(btrim(recipient_email)));
`;
      expect(normalizeDiff(run79)).toBe(
        "ALTER TABLE app_private.cessions_point_parcels_backup_20261011\n  ALTER COLUMN confidence DROP NOT NULL;",
      );
      // A changed regular expression in the wrapped ADD stays reported.
      expect(normalizeDiff(run79.replace("+\\.[^[:space:]@]+$", "+\\.[^[:space:]@]*$"))).toContain(
        "information_agent_cases_recipient_email_check",
      );
    });

    it("lists the pinned entries that match nothing in the diff", () => {
      const all = RECONCILED_CHECK_CONSTRAINTS.map((constraint) => constraint.name);
      expect(normalizeDiffWithNotes("").unusedReconciledChecks).toEqual(all);
      const constraint = pinned("auction_fact_claims_field_key_check");
      const notes = normalizeDiffWithNotes(pairFor(constraint, constraint.productionDefinition));
      expect(notes.diff).toBe("");
      expect(notes.unusedReconciledChecks).toEqual(all.filter((name) => name !== constraint.name));
      // A pair whose definition differs is drift, not an unused entry.
      const altered = normalizeDiffWithNotes(
        pairFor(constraint, constraint.productionDefinition.replace("<= 128", "<= 129")),
      );
      expect(altered.diff).toContain("<= 129");
      expect(altered.unusedReconciledChecks).not.toContain(constraint.name);
    });

    it("pins what the migrations really define (last definition wins)", () => {
      const files = readdirSync(migrationsDirectory)
        .filter((file) => /^\d{14}_.+\.sql$/.test(file))
        .sort();
      for (const { table, name, productionDefinition } of RECONCILED_CHECK_CONSTRAINTS) {
        let defined = null;
        for (const file of files) {
          const condition = checkConditionFromMigration(
            readFileSync(join(migrationsDirectory, file), "utf8"),
            table.replace(/^public\./, ""),
            name,
          );
          if (condition !== null) defined = { file, condition };
        }
        expect(defined, `no migration defines ${table}.${name}`).not.toBeNull();
        expect(
          canonicalCheckCondition(expandBetween(normalizeEscapeStrings(defined.condition))),
          `${name} (${defined.file})`,
        ).toBe(canonicalCheckCondition(checkBody(productionDefinition)));
      }
    });
  });

  it("propagates a missing or invalid physical index from the runner check", async () => {
    const calls = [];
    await expect(
      verifyConcurrentIndexes("postgres://example.invalid/postgres", async (options) => {
        calls.push(options);
        throw new Error(
          "Index auction_sales_postal_code_idx is missing or invalid in --check mode.",
        );
      }),
    ).rejects.toThrow("missing or invalid");
    expect(calls).toEqual([
      { checkOnly: true, databaseUrl: "postgres://example.invalid/postgres" },
    ]);
  });
});

describe("Transient connection failures of the diff tool (run 80)", () => {
  const run80 =
    "error diffing schema: error running script: Error: timeout exceeded when trying to connect\n    at pg-pool extractCurrentUser\nPGDELTA_SCRIPT_ERROR";

  it("recognises the run 80 pg-delta timeout and other connection failures", () => {
    for (const output of [
      run80,
      "Error: Connection terminated due to connection timeout",
      "read ECONNRESET",
      "connect ETIMEDOUT 10.0.0.1:5432",
      "connect ECONNREFUSED 127.0.0.1:5432",
      "getaddrinfo EAI_AGAIN db.example.supabase.co",
      "failed to connect to `host=db.example user=postgres`: dial error (timeout: 10s)",
      "dial tcp 10.0.0.1:5432: i/o timeout",
    ]) {
      expect(isTransientConnectionFailure(output), output).toBe(true);
    }
  });

  it("does not treat real errors, SQL errors or an empty output as transient", () => {
    for (const output of [
      "",
      undefined,
      "PGDELTA_SCRIPT_ERROR",
      'error diffing schema: error running script: Error: syntax error at or near "FROM"\nPGDELTA_SCRIPT_ERROR',
      "password authentication failed for user postgres",
      "ALTER TABLE public.auction_sales DROP CONSTRAINT auction_sales_other_check;",
    ]) {
      expect(isTransientConnectionFailure(output), String(output)).toBe(false);
    }
  });

  it("waits 20 s then 40 s and succeeds on the third attempt", async () => {
    const outcomes = [
      { status: 1, stdout: "", stderr: run80 },
      { status: 1, stdout: "", stderr: "read ECONNRESET" },
      { status: 0, stdout: "", stderr: "" },
    ];
    const sleeps = [];
    const logs = [];
    const outcome = await runWithTransientRetry({
      attempt: async (number) => outcomes[number - 1],
      sleep: async (seconds) => sleeps.push(seconds),
      log: (message) => logs.push(message),
    });
    expect(TRANSIENT_RETRY_DELAYS_SECONDS).toEqual([20, 40]);
    expect(sleeps).toEqual([20, 40]);
    expect(logs).toHaveLength(2);
    expect(outcome).toMatchObject({ attempts: 3, transient: false, result: { status: 0 } });
  });

  it("gives up after 3 attempts and reports the tool as unreachable", async () => {
    let calls = 0;
    const sleeps = [];
    const outcome = await runWithTransientRetry({
      attempt: async () => {
        calls += 1;
        return { status: 1, stdout: "", stderr: run80 };
      },
      sleep: async (seconds) => sleeps.push(seconds),
    });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([20, 40]);
    expect(outcome).toMatchObject({ attempts: 3, transient: true, result: { status: 1 } });
  });

  it("never retries a non-transient failure", async () => {
    let calls = 0;
    const outcome = await runWithTransientRetry({
      attempt: async () => {
        calls += 1;
        return { status: 1, stdout: "", stderr: "syntax error at or near" };
      },
      sleep: async () => {
        throw new Error("must not wait");
      },
    });
    expect(calls).toBe(1);
    expect(outcome).toMatchObject({ attempts: 1, transient: false });
  });

  it("never re-runs a completed diff, so a real drift is not retried or masked", async () => {
    let calls = 0;
    const outcome = await runWithTransientRetry({
      attempt: async () => {
        calls += 1;
        // The tool succeeded; the drift lives in the output file, not in the output.
        // Even a stray connection-looking text on a successful run is not a failure.
        return { status: 0, stdout: "", stderr: "read ECONNRESET (recovered)" };
      },
      sleep: async () => {
        throw new Error("must not wait");
      },
    });
    expect(calls).toBe(1);
    expect(outcome).toMatchObject({ attempts: 1, transient: false, result: { status: 0 } });
  });

  it("does not retry at all with an empty delay list (local mode)", async () => {
    let calls = 0;
    const outcome = await runWithTransientRetry({
      attempt: async () => {
        calls += 1;
        return { status: 1, stdout: "", stderr: run80 };
      },
      delaysSeconds: [],
      sleep: async () => {
        throw new Error("must not wait");
      },
    });
    expect(calls).toBe(1);
    expect(outcome.transient).toBe(true);
  });
});

describe("Report of a failed diff tool", () => {
  const toolLines = (count) =>
    Array.from({ length: count }, (_unused, index) => `tool line ${index + 1}`).join("\n");

  it("puts the diagnosis first and keeps only the end of each output", () => {
    const report = diffToolFailureReport({
      result: { status: 1, stdout: `${toolLines(5000)}\n`, stderr: "warning\nreal error\n" },
      attempts: 1,
      transient: false,
    }).split("\n");

    expect(report[0]).toMatch(/^\[schema-drift\] DIFF TOOL FAILED: /);
    expect(report[1]).toBe(
      `[schema-drift] Diff tool stdout, last ${DIFF_TOOL_FAILURE_TAIL_LINES} of 5000 line(s):`,
    );
    expect(report[2]).toBe(`> tool line ${5000 - DIFF_TOOL_FAILURE_TAIL_LINES + 1}`);
    expect(report.slice(-4)).toEqual([
      "> tool line 5000",
      "[schema-drift] Diff tool stderr, last 2 of 2 line(s):",
      "> warning",
      "> real error",
    ]);
    expect(report).toHaveLength(1 + 1 + DIFF_TOOL_FAILURE_TAIL_LINES + 1 + 2);
  });

  it("names an unreachable tool, the GitHub annotation and the spawn error before any output", () => {
    const report = diffToolFailureReport({
      result: { status: null, stdout: "", stderr: "", error: new Error("spawnSync npx ENOENT") },
      attempts: 3,
      transient: true,
      githubActions: true,
    }).split("\n");

    expect(report).toHaveLength(3);
    expect(report[0]).toMatch(/^\[schema-drift\] TOOL UNREACHABLE: .* after 3 attempts\. /);
    expect(report[1]).toMatch(/^::error title=Schema drift tool unreachable::TOOL UNREACHABLE: /);
    expect(report[2]).toBe("[schema-drift] Diff tool not run to its end: spawnSync npx ENOENT");
  });

  it("says that the output was truncated when the tool overran the buffer", () => {
    const report = diffToolFailureReport({
      result: {
        status: null,
        stdout: "partial",
        stderr: "",
        error: Object.assign(new Error("spawnSync npx ENOBUFS"), { code: "ENOBUFS" }),
      },
      attempts: 1,
      transient: false,
    }).split("\n");

    expect(report[1]).toMatch(/^\[schema-drift\] OUTPUT TRUNCATED BY THE BUFFER: /);
    expect(report.slice(2)).toEqual([
      "[schema-drift] Diff tool stdout, last 1 of 1 line(s):",
      "> partial",
    ]);
  });

  it("does not let one endless line through whole", () => {
    const report = diffToolFailureReport({
      result: { status: 1, stdout: "", stderr: `first line\n${"y".repeat(500_000)}END\n` },
      attempts: 1,
      transient: false,
    }).split("\n");

    expect(report).toHaveLength(3);
    expect(report[1]).toBe(
      `[schema-drift] Diff tool stderr, last 1 of 2 line(s), cut to their last ${DIFF_TOOL_FAILURE_TAIL_CHARACTERS} characters:`,
    );
    expect(report[2]).toHaveLength(2 + DIFF_TOOL_FAILURE_TAIL_CHARACTERS);
    expect(report[2].endsWith("yEND")).toBe(true);
  });

  it("masks the connection target and its password wherever the tool prints them", () => {
    // Fictitious URL and password.
    const password = "S3cr/t-fake:pw";
    const configured = `postgresql://postgres.abcdefgh:${encodeURIComponent(password)}@aws-0-eu-west-3.pooler.supabase.com:6543/postgres`;
    const target = `${configured.replace(":6543/", ":5432/")}?sslmode=verify-full&connect_timeout=600`;
    const report = diffToolFailureReport({
      result: {
        status: 1,
        stdout: `connecting to ${target}\nretrying ${configured} now\n`,
        stderr: [
          `failed to connect to "postgres://postgres.abcdefgh:other-form@aws-0-eu-west-3.pooler.supabase.com/postgres": timeout`,
          `password authentication failed (password=${password})`,
          `encoded: ${encodeURIComponent(password)}`,
          "real error",
        ].join("\n"),
        error: new Error(`spawnSync npx --to ${target} ETIMEDOUT`),
      },
      attempts: 1,
      transient: false,
      databaseUrls: [configured, target],
    });

    expect(report).not.toContain("S3cr");
    expect(report).not.toContain("other-form");
    expect(report).not.toContain("pooler.supabase.com");
    expect(report).not.toContain("abcdefgh");
    expect(report.split("\n").slice(1)).toEqual([
      "[schema-drift] Diff tool not run to its end: spawnSync npx --to [masqué] ETIMEDOUT",
      "[schema-drift] Diff tool stdout, last 2 of 2 line(s):",
      "> connecting to [masqué]",
      "> retrying [masqué] now",
      "[schema-drift] Diff tool stderr, last 4 of 4 line(s):",
      '> failed to connect to "[masqué] timeout',
      "> password authentication failed (password=[masqué])",
      "> encoded: [masqué]",
      "> real error",
    ]);
  });

  it("copies no line of the tool that GitHub could read as a workflow command", () => {
    const report = diffToolFailureReport({
      result: {
        status: 1,
        stdout:
          "::error title=Forged::forged\n  ::add-mask::x\n##[error]forged\nplain\r::stop-commands::token\n",
        stderr: "::set-output name=a::b\nmiddle ##[group]forged ##[endgroup]",
        error: new Error("first\n::warning::forged\n##[error]forged"),
      },
      attempts: 1,
      transient: false,
    }).split("\n");

    expect(report).toHaveLength(11);
    for (const line of report) expect(line).toMatch(/^(?:\[schema-drift\] |> )/);
    expect(report).toContain("> ::stop-commands::token");
    // `##[` is broken wherever it stands: the `> ` prefix alone would leave it readable.
    for (const line of report) expect(line).not.toContain("##[");
    expect(report).toContain("> ## [error]forged");
    expect(report).toContain("> middle ## [group]forged ## [endgroup]");
    expect(report[1]).toBe(
      "[schema-drift] Diff tool not run to its end: first ::warning::forged ## [error]forged",
    );
  });

  it("masks the password as written in the URL, in either case of its escapes, and when wrapped", () => {
    // Fictitious URLs and passwords. The first password holds an unencoded `@`, `/` and `#`: the URL parser
    // reads `Fk55` as the password and `ss` as the host.
    const written = "Fk55@ss/w#rd-fake";
    const unparsed = `postgresql://postgres:${written}@db.example.invalid:5432/postgres`;
    const encoded = "Fake%2Fpw%3Atail";
    const parsed = `postgresql://postgres.abcdefgh:${encoded}@aws-0-eu-west-3.pooler.supabase.com:6543/postgres`;
    const report = diffToolFailureReport({
      result: {
        status: 1,
        stdout: "",
        stderr: [
          `as written: password=${written}`,
          `lower case escapes: ${encoded.replaceAll("%2F", "%2f").replaceAll("%3A", "%3a")}`,
          `wrapped url: ${parsed.slice(0, 40)}\n    ${parsed.slice(40)} end`,
          `wrapped password: ${written.slice(0, 5)}\r\n\t${written.slice(5)} end`,
          "real error",
        ].join("\n"),
      },
      attempts: 1,
      transient: false,
      databaseUrls: [unparsed, parsed],
    });

    for (const leak of ["w#rd", "Fk55", "%2fpw", "%2Fpw", "tail", "abcdefgh", "pooler"])
      expect(report).not.toContain(leak);
    expect(report.split("\n").slice(1)).toEqual([
      "[schema-drift] Diff tool stderr, last 5 of 5 line(s):",
      "> as written: password=[masqué]",
      "> lower case escapes: [masqué]",
      "> wrapped url: [masqué] end",
      "> wrapped password: [masqué] end",
      "> real error",
    ]);
  });

  // The whole script, in local mode, with a stand-in for `npx` (the only thing on its PATH besides the
  // system tools: nothing is downloaded, no database is reached).
  function withStandInTool(toolScript, launch) {
    const directory = mkdtempSync(join(tmpdir(), "immojudis-schema-drift-test-"));
    try {
      const standIn = join(directory, "npx");
      writeFileSync(standIn, `#!/bin/sh\n${toolScript}\n`);
      chmodSync(standIn, 0o755);
      return launch({
        script: join(dirname(fileURLToPath(import.meta.url)), "check-supabase-schema-drift.mjs"),
        options: {
          encoding: "utf8",
          env: { PATH: `${directory}:/usr/bin:/bin`, GITHUB_ACTIONS: "true" },
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const runScriptWithStandInTool = (toolScript) =>
    withStandInTool(toolScript, ({ script, options }) => {
      const run = spawnSync(process.execPath, [script], options);
      return { status: run.status, stdout: run.stdout, stderr: run.stderr.trimEnd().split("\n") };
    });
  const wholeScript = { skip: process.platform === "win32", timeout: 30_000 };

  it(
    "prints the diagnosis first and the end of the tool output to its last line, with the tool status",
    wholeScript,
    () => {
      // stdout: 2 MiB, beyond the default 1 MiB buffer of spawnSync. stderr: its last 200 lines weigh
      // 90 KiB, beyond the 64 KiB that a pipe holds. The output goes to a real pipe that nobody reads
      // for one second, as a busy CI log collector does: a script that exits without waiting for its
      // writes loses what the pipe could not take, the last line first.
      const printed = withStandInTool(
        [
          "seq 1 40000 | sed 's/$/ tool line padded to pass the default buffer of 1 MiB/'",
          `seq 1 300 | sed 's/$/ error line ${"e".repeat(440)}/' >&2`,
          'echo "final error line" >&2',
          "exit 3",
        ].join("\n"),
        ({ script, options }) =>
          spawnSync(
            "/bin/sh",
            [
              "-c",
              '{ "$0" "$1" 2>&1; echo "status $?"; } | { sleep 1; cat; }',
              process.execPath,
              script,
            ],
            options,
          )
            .stdout.trimEnd()
            .split("\n"),
      );

      expect(printed[0]).toMatch(/^\[schema-drift\] DIFF TOOL FAILED: /);
      expect(printed[1]).toMatch(/^::error title=Schema drift tool failed::DIFF TOOL FAILED: /);
      expect(printed[2]).toBe(
        `[schema-drift] Diff tool stdout, last ${DIFF_TOOL_FAILURE_TAIL_LINES} of 40000 line(s):`,
      );
      expect(printed[3]).toBe(
        `> ${40000 - DIFF_TOOL_FAILURE_TAIL_LINES + 1} tool line padded to pass the default buffer of 1 MiB`,
      );
      expect(printed[3 + DIFF_TOOL_FAILURE_TAIL_LINES]).toBe(
        `[schema-drift] Diff tool stderr, last ${DIFF_TOOL_FAILURE_TAIL_LINES} of 301 line(s):`,
      );
      expect(printed).toHaveLength(
        3 + DIFF_TOOL_FAILURE_TAIL_LINES + 1 + DIFF_TOOL_FAILURE_TAIL_LINES + 1,
      );
      expect(printed.slice(-2)).toEqual(["> final error line", "status 3"]);
      expect(printed.slice(-DIFF_TOOL_FAILURE_TAIL_LINES).join("\n").length).toBeGreaterThan(
        80 * 1024,
      );
    },
  );

  it(
    "fails when the tool is killed by a signal, and never says that the schema matches",
    wholeScript,
    () => {
      const run = runScriptWithStandInTool("kill -9 $$");

      expect(run.status).toBe(1);
      expect(run.stderr[0]).toMatch(/^\[schema-drift\] DIFF TOOL FAILED: /);
      expect(`${run.stdout}\n${run.stderr.join("\n")}`).not.toContain("matches");
    },
  );

  it(
    "fails and says so when the tool overruns the buffer, whatever its own status",
    wholeScript,
    () => {
      const run = runScriptWithStandInTool("head -c 17000000 /dev/zero | tr '\\0' 'x'\nexit 0");

      expect(run.status).toBe(1);
      expect(run.stderr[0]).toMatch(/^\[schema-drift\] DIFF TOOL FAILED: /);
      expect(run.stderr[2]).toMatch(/^\[schema-drift\] OUTPUT TRUNCATED BY THE BUFFER: /);
      expect(run.stderr[3]).toBe(
        `[schema-drift] Diff tool stdout, last 1 of 1 line(s), cut to their last ${DIFF_TOOL_FAILURE_TAIL_CHARACTERS} characters:`,
      );
      expect(run.stderr).toHaveLength(5);
      expect(`${run.stdout}\n${run.stderr.join("\n")}`).not.toContain("matches");
    },
  );

  const writeDiff = (sql) =>
    `for argument in "$@"; do case "$argument" in --output=*) printf '%b' "${sql}" > "\${argument#--output=}";; esac; done\nexit 0`;

  it(
    "fails with REAL DRIFT first when the tool succeeds and its diff is not empty",
    wholeScript,
    () => {
      const run = runScriptWithStandInTool(writeDiff("DROP POLICY x ON public.auction_sales;\\n"));

      expect(run.status).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toEqual([
        "[schema-drift] REAL DRIFT: Local database differs from committed migrations.",
        "::error title=Schema drift::Real drift detected: the schema differs from the committed migrations (not a connectivity problem).",
        "> DROP POLICY x ON public.auction_sales;",
      ]);
    },
  );

  it("copies no line of the diff that GitHub could read as a workflow command", wholeScript, () => {
    // A comment or a name read from the database may hold anything, line breaks included.
    const run = runScriptWithStandInTool(
      writeDiff(
        "COMMENT ON TABLE public.t IS 'a\\n::error title=Forged::forged\\n##[error]forged\\nb ##[group]c\\r::add-mask::d';\\n",
      ),
    );

    expect(run.status).toBe(1);
    expect(run.stderr.slice(2)).toEqual([
      "> COMMENT ON TABLE public.t IS 'a",
      "> ::error title=Forged::forged",
      "> ## [error]forged",
      "> b ## [group]c",
      "> ::add-mask::d';",
    ]);
  });

  it("masks a connection URL quoted by the diff", wholeScript, () => {
    // Fictitious URL: in local mode the script knows no target, any Postgres URL is masked all the same.
    const run = runScriptWithStandInTool(
      writeDiff(
        "COMMENT ON TABLE public.t IS 'see postgresql://postgres:Fk55-fake@db.example.invalid:5432/postgres';\\nDROP POLICY x ON public.t;\\n",
      ),
    );

    expect(run.status).toBe(1);
    expect(run.stderr.slice(2)).toEqual([
      "> COMMENT ON TABLE public.t IS 'see [masqué]",
      "> DROP POLICY x ON public.t;",
    ]);
  });

  it("masks the password of the compared database wherever the diff quotes it", () => {
    // Fictitious URL and password, as the script passes them in --remote mode.
    const target =
      "postgresql://postgres.abcdefgh:Fake%2Fpw@aws-0-eu-west-3.pooler.supabase.com:5432/postgres";
    expect(
      quoteForeignText(
        `COMMENT ON TABLE public.t IS 'pw Fake/pw or Fake%2fpw';\n-- ${target}\n##[error]x`,
        [target],
      ),
    ).toBe(
      "> COMMENT ON TABLE public.t IS 'pw [masqué] or [masqué]';\n> -- [masqué]\n> ## [error]x",
    );
  });

  it("succeeds when the diff holds nothing but the reviewed indexes", wholeScript, () => {
    const run = runScriptWithStandInTool(
      writeDiff(
        "CREATE INDEX auction_sales_held_fields_idx ON public.auction_sales (id)\\n  WHERE held_fields IS NOT NULL;\\n",
      ),
    );

    expect(run).toEqual({
      status: 0,
      stdout: "[schema-drift] Local database matches committed migrations.\n",
      stderr: [""],
    });
  });
});
