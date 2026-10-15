import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import cases from "./seo-indexable-cases.json";
import {
  INDEXABLE_DOCUMENTED_DESCRIPTION_LENGTH,
  isIndexablePublicSale,
  type IndexableSaleFacts,
} from "./seo";

type Case = {
  name: string;
  facts: IndexableSaleFacts & { description_length?: number };
  indexable: boolean;
};

const MIGRATION = "supabase/migrations/20261025120000_indexable_public_sale_predicate.sql";

function toFacts(facts: Case["facts"]): IndexableSaleFacts {
  const { description_length, ...rest } = facts;
  return {
    ...rest,
    ...(description_length ? { description: "x".repeat(description_length) } : {}),
  };
}

describe("isIndexablePublicSale (TypeScript predicate)", () => {
  it.each(cases as Case[])("$name -> $indexable", ({ facts, indexable }) => {
    expect(isIndexablePublicSale(toFacts(facts))).toBe(indexable);
  });

  it("does not read the completeness tier", () => {
    const base = toFacts((cases as Case[])[0].facts);
    expect(isIndexablePublicSale({ ...base, ...{ completeness_tier: 0 } })).toBe(true);
  });

  it("rejects an unparsable hearing date like a missing one", () => {
    const base = toFacts((cases as Case[])[0].facts);
    expect(isIndexablePublicSale({ ...base, sale_date: "pas une date" })).toBe(false);
  });
});

describe("SQL predicate app_private.is_indexable_public_sale (migration)", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("carries the same constants as the TypeScript predicate", () => {
    expect(INDEXABLE_DOCUMENTED_DESCRIPTION_LENGTH).toBe(500);
    expect(sql).toContain(
      `coalesce(p_description_length, 0) >= ${INDEXABLE_DOCUMENTED_DESCRIPTION_LENGTH}`,
    );
    expect(sql).toContain("sale_date_implausible");
    expect(sql).toContain("'cessions_etat'");
    expect(sql).toContain("p_sale_venue_type = 'state'");
    expect(sql).toContain("not in ('other', 'unknown')");
    expect(sql.replace(/^\s*--.*$/gm, "")).not.toMatch(/completeness_tier/);
  });

  it("is used by the sitemap function (same signature) and by the page verdict", () => {
    expect(sql).toMatch(
      /create or replace function app_private\.list_public_sale_sitemap_entries\(\s*p_limit integer default 1000,\s*p_offset integer default 0\s*\)/,
    );
    expect(sql).toMatch(/and app_private\.is_indexable_public_sale\(/);
    expect(sql).toContain("function public.get_public_sale_indexability(p_sale_id uuid)");
    expect(sql).toMatch(
      /grant execute on function app_private\.list_public_sale_sitemap_entries\(integer, integer\)\s+to anon, authenticated, service_role;/,
    );
  });

  // Opt-in, against a SCRATCH PostgreSQL only (never a shared or production database): the
  // function is created inside a transaction that is rolled back, then every shared case is
  // evaluated by SQL and compared with the expected verdict.
  //   INDEXABLE_SALE_SQL_DATABASE_URL=postgresql://... npx vitest run src/lib/seo-indexable.test.ts
  const databaseUrl = process.env.INDEXABLE_SALE_SQL_DATABASE_URL;
  it.skipIf(!databaseUrl)("agrees with the TypeScript predicate on every shared case", () => {
    const start = sql.indexOf("create or replace function app_private.is_indexable_public_sale(");
    const end = sql.indexOf("$function$;", start) + "$function$;".length;
    const functionSql = sql.slice(start, end);
    const literal = (value: unknown, cast: string): string =>
      value === undefined || value === null
        ? `null::${cast}`
        : typeof value === "number"
          ? `${value}::${cast}`
          : `'${JSON.stringify(value).replace(/^"|"$/g, "").replaceAll("'", "''")}'::${cast}`;
    const rows = (cases as Case[]).map(({ facts }, index) => {
      const documents = facts.document_count ?? 0;
      return `(${index}, ${[
        literal(facts.city, "text"),
        literal(facts.sale_date, "timestamptz"),
        literal(facts.property_type, "text"),
        literal(facts.app_surface_m2, "numeric"),
        literal(facts.starting_price_eur, "numeric"),
        facts.quality_flags ? `'${JSON.stringify(facts.quality_flags)}'::jsonb` : "'[]'::jsonb",
        literal(facts.primary_source, "text"),
        literal(facts.sale_venue_type, "text"),
        literal(facts.description_length ?? null, "integer"),
        literal(documents, "integer"),
      ].join(", ")})`;
    });
    const script = [
      "begin;",
      "create schema if not exists app_private;",
      functionSql,
      `select coalesce(json_agg(verdict order by id), '[]'::json) from (
         select id, app_private.is_indexable_public_sale(c1, c2, c3, c4, c5, c6, c7, c8, c9, c10) as verdict
         from (values ${rows.join(",\n")}) as t(id, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10)
       ) q;`,
      "rollback;",
    ].join("\n");
    const output = execFileSync(
      "psql",
      ["-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", databaseUrl!],
      {
        input: script,
        encoding: "utf8",
      },
    );
    const verdicts = JSON.parse(output.split("\n").find((line) => line.startsWith("["))!);
    expect(verdicts).toEqual((cases as Case[]).map(({ indexable }) => indexable));
  });
});
