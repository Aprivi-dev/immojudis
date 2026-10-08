import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyOperation,
  indexMatches,
  operations,
  resolveSslOptions,
  runConcurrentIndexOperations,
  withSessionConnectionUrl,
} from "./apply-supabase-concurrent-index-operations.mjs";

function withEnvironment(values, callback) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fakeSql(rows) {
  const sql = () => Promise.resolve(rows);
  sql.unsafe = () => Promise.resolve();
  return sql;
}

describe("Supabase concurrent index operation allowlist", () => {
  it("keeps exactly the four reviewed hot-path operations", () => {
    expect(operations.map((operation) => operation.indexName)).toEqual([
      "auction_sales_source_urls_gin_idx",
      "auction_sales_postal_code_idx",
      "auction_collection_items_run_source_url_idx",
      "auction_collection_items_run_canonical_source_url_idx",
    ]);
    expect(
      operations.every((operation) => operation.createSql.includes("create index concurrently")),
    ).toBe(true);
  });

  it("accepts only exact catalog definitions for the reviewed operation", () => {
    const [operation] = operations;
    expect(
      indexMatches(operation, {
        index_def:
          "CREATE INDEX auction_sales_source_urls_gin_idx ON public.auction_sales USING gin (source_urls)",
        access_method: "gin",
        key_columns: ["source_urls"],
        is_partial: false,
        has_expressions: false,
      }),
    ).toBe(true);
    expect(
      indexMatches(operation, {
        index_def:
          "CREATE INDEX auction_sales_source_urls_gin_idx ON public.auction_sales (postal_code)",
        access_method: "btree",
        key_columns: ["postal_code"],
        is_partial: false,
        has_expressions: false,
      }),
    ).toBe(false);
  });

  it("rejects a matching table with the wrong composite-column order", () => {
    const [, , operation] = operations;
    expect(
      indexMatches(operation, {
        index_def:
          "CREATE INDEX auction_collection_items_run_source_url_idx ON public.auction_collection_items (source_url, run_id)",
        access_method: "btree",
        key_columns: ["source_url", "run_id"],
        is_partial: false,
        has_expressions: false,
      }),
    ).toBe(false);
  });

  it("normalizes Supabase transaction-pooler URLs to the session port", () => {
    expect(
      new URL(
        withSessionConnectionUrl(
          "postgres://user:password@aws-0-eu-west-1.pooler.supabase.com:6543/postgres",
        ),
      ).port,
    ).toBe("5432");
    expect(() =>
      withSessionConnectionUrl("postgres://user:password@db.example:6543/postgres"),
    ).toThrow("transaction-pooler");
  });

  it("requires verified TLS by default and only permits disabled TLS locally", () => {
    withEnvironment({ POSTGRES_SSL: undefined, IMMOJUDIS_LOCAL_INTEGRATION: undefined }, () => {
      expect(resolveSslOptions("postgres://user:password@db.example:5432/postgres")).toEqual({
        rejectUnauthorized: true,
      });
      expect(() =>
        resolveSslOptions("postgres://user:password@db.example:5432/postgres"),
      ).not.toThrow();
    });

    withEnvironment({ POSTGRES_SSL: "disable", IMMOJUDIS_LOCAL_INTEGRATION: undefined }, () => {
      expect(() => resolveSslOptions("postgres://user:password@db.example:5432/postgres")).toThrow(
        "explicit local",
      );
      expect(resolveSslOptions("postgres://user:password@localhost:5432/postgres")).toBe(false);
    });
  });

  it("accepts a CA from the dedicated environment variable without logging it", () => {
    withEnvironment(
      {
        POSTGRES_SSL: undefined,
        PGSSLROOTCERT: undefined,
        POSTGRES_SSL_CA: "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----",
        SUPABASE_DB_SSL_CA: undefined,
      },
      () => {
        expect(resolveSslOptions("postgres://user:password@db.example:5432/postgres")).toEqual({
          rejectUnauthorized: true,
          ca: "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----",
        });
      },
    );
  });

  it("reads an optional CA from PGSSLROOTCERT without printing its contents", () => {
    const directory = mkdtempSync(join(tmpdir(), "immojudis-ca-"));
    const path = join(directory, "root.crt");
    const ca = "-----BEGIN CERTIFICATE-----\nfixture-file\n-----END CERTIFICATE-----";
    writeFileSync(path, ca);
    try {
      withEnvironment(
        {
          POSTGRES_SSL: undefined,
          PGSSLROOTCERT: path,
          POSTGRES_SSL_CA: undefined,
          SUPABASE_DB_SSL_CA: undefined,
        },
        () => {
          expect(resolveSslOptions("postgres://user:password@db.example:5432/postgres")).toEqual({
            rejectUnauthorized: true,
            ca,
          });
        },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails --check when an applied row has no valid physical index", async () => {
    const [operation] = operations;
    const row = {
      operation_key: operation.operationKey,
      schema_name: operation.schemaName,
      table_name: operation.tableName,
      index_name: operation.indexName,
      create_sql: operation.createSql,
      status: "applied",
    };

    await expect(applyOperation(fakeSql([]), operation, row, true)).rejects.toThrow(
      "missing or invalid",
    );
    await expect(
      applyOperation(
        fakeSql([
          {
            index_def:
              "CREATE INDEX auction_sales_source_urls_gin_idx ON public.auction_sales USING gin (source_urls)",
            access_method: "gin",
            key_columns: ["source_urls"],
            is_partial: false,
            has_expressions: false,
            indisvalid: false,
          },
        ]),
        operation,
        row,
        true,
      ),
    ).rejects.toThrow("missing or invalid");
  });

  it("closes the pool when the initial history query fails", async () => {
    let closed = 0;
    let receivedOptions;
    const clientFactory = (_url, options) => {
      receivedOptions = options;
      const sql = () => Promise.reject(new Error("history query failed"));
      sql.end = async () => {
        closed += 1;
      };
      return sql;
    };

    await withEnvironment({ POSTGRES_SSL: undefined }, async () => {
      await expect(
        runConcurrentIndexOperations({
          databaseUrl: "postgres://user:password@127.0.0.1:5432/postgres",
          clientFactory,
        }),
      ).rejects.toThrow("history query failed");
    });
    expect(closed).toBe(1);
    expect(receivedOptions.ssl).toEqual({ rejectUnauthorized: true });
  });
});
