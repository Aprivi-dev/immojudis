import { describe, expect, it } from "vitest";

import {
  normalizeConcurrentIndexDefinition,
  normalizeDiff,
  verifyConcurrentIndexes,
} from "./lib/schema-drift.mjs";

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
