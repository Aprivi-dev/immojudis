import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  RECONCILED_CHECK_CONSTRAINTS,
  canonicalCheckCondition,
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

  it("preserves the existing platform-managed drift filters", () => {
    expect(
      normalizeDiff(`
CREATE EXTENSION pg_net WITH SCHEMA public;
GRANT SELECT ON public.auction_sales TO lovable_readonly;
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
