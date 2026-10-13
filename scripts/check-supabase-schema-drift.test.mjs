import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  RECONCILED_CHECK_CONSTRAINTS,
  canonicalCheckCondition,
  normalizeConcurrentIndexDefinition,
  normalizeDiff,
  verifyConcurrentIndexes,
} from "./lib/schema-drift.mjs";

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

    it("pins definitions that the named migrations really contain", () => {
      for (const {
        table,
        name,
        productionDefinition: definition,
        migration,
      } of RECONCILED_CHECK_CONSTRAINTS) {
        const source = readFileSync(join(migrationsDirectory, migration), "utf8");
        const tableName = table.replace(/^public\./, "");
        expect(source, `${migration} must create ${tableName}`).toMatch(
          new RegExp(`create table (?:if not exists )?(?:public\\.)?${tableName}\\b`, "i"),
        );
        if (name.endsWith("_check") && source.includes(`constraint ${name} `)) {
          expect(source).toContain(`constraint ${name} check`);
        }
        for (const literal of definition.match(/'(?:[^']|'')*'/g) ?? []) {
          if (literal === "''") continue;
          const body = literal.slice(1, -1);
          expect(
            source.includes(body) || source.includes(body.replaceAll("\\", "\\\\")),
            `${migration} must contain the literal ${literal}`,
          ).toBe(true);
        }
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
