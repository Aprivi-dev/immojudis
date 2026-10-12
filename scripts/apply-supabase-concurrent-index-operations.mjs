import postgres from "postgres";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const operations = Object.freeze([
  Object.freeze({
    operationKey: "20261008102334:auction_sales_source_urls_gin_idx",
    schemaName: "public",
    tableName: "auction_sales",
    indexName: "auction_sales_source_urls_gin_idx",
    createSql:
      'create index concurrently if not exists "auction_sales_source_urls_gin_idx" on "public"."auction_sales" using gin ("source_urls")',
    accessMethod: "gin",
    keyColumns: ["source_urls"],
    expectedFragments: ["using gin", "auction_sales", "source_urls"],
  }),
  Object.freeze({
    operationKey: "20261008102334:auction_sales_postal_code_idx",
    schemaName: "public",
    tableName: "auction_sales",
    indexName: "auction_sales_postal_code_idx",
    createSql:
      'create index concurrently if not exists "auction_sales_postal_code_idx" on "public"."auction_sales" ("postal_code")',
    accessMethod: "btree",
    keyColumns: ["postal_code"],
    expectedFragments: ["auction_sales", "postal_code"],
  }),
  Object.freeze({
    operationKey: "20261008102334:auction_collection_items_run_source_url_idx",
    schemaName: "public",
    tableName: "auction_collection_items",
    indexName: "auction_collection_items_run_source_url_idx",
    createSql:
      'create index concurrently if not exists "auction_collection_items_run_source_url_idx" on "public"."auction_collection_items" ("run_id", "source_url")',
    accessMethod: "btree",
    keyColumns: ["run_id", "source_url"],
    expectedFragments: ["auction_collection_items", "run_id", "source_url"],
  }),
  Object.freeze({
    operationKey: "20261008102334:auction_collection_items_run_canonical_source_url_idx",
    schemaName: "public",
    tableName: "auction_collection_items",
    indexName: "auction_collection_items_run_canonical_source_url_idx",
    createSql:
      'create index concurrently if not exists "auction_collection_items_run_canonical_source_url_idx" on "public"."auction_collection_items" ("run_id", "canonical_source_url")',
    accessMethod: "btree",
    keyColumns: ["run_id", "canonical_source_url"],
    expectedFragments: ["auction_collection_items", "run_id", "canonical_source_url"],
  }),
]);

function connectionUrl() {
  const value = String(
    process.env.SUPABASE_DB_URL ||
      process.env.POSTGRES_URL_NON_POOLING ||
      process.env.POSTGRES_URL ||
      "",
  ).trim();
  if (!value) {
    throw new Error("SUPABASE_DB_URL, POSTGRES_URL_NON_POOLING or POSTGRES_URL is required.");
  }
  return value;
}

function withSessionConnectionUrl(value) {
  const url = new URL(value);
  const isSupabasePooler = url.hostname.toLowerCase().endsWith(".pooler.supabase.com");
  if (isSupabasePooler) {
    // Supavisor transaction mode (6543) cannot safely run this operation;
    // force the session endpoint just as the migration runner does.
    url.port = "5432";
  } else if (url.port === "6543") {
    throw new Error(
      "A transaction-pooler port (6543) is not allowed for concurrent index operations.",
    );
  }
  return url.toString();
}

function isExplicitLocalDatabaseUrl(value) {
  const hostname = new URL(value).hostname.toLowerCase();
  return ["localhost", "127.0.0.1", "::1"].includes(hostname) || hostname.endsWith(".localhost");
}

function resolveSslOptions(databaseUrl) {
  const mode = String(process.env.POSTGRES_SSL || "")
    .trim()
    .toLowerCase();
  if (mode === "disable") {
    if (!isExplicitLocalDatabaseUrl(databaseUrl)) {
      throw new Error(
        "POSTGRES_SSL=disable is allowed only for an explicit local database connection.",
      );
    }
    return false;
  }
  if (mode && !["require", "verify-full"].includes(mode)) {
    throw new Error("POSTGRES_SSL must be unset, require, verify-full, or disable.");
  }

  const rootCertificatePath = String(process.env.PGSSLROOTCERT || "").trim();
  const configuredCertificate = String(
    process.env.POSTGRES_SSL_CA || process.env.SUPABASE_DB_SSL_CA || "",
  ).trim();
  const ca = rootCertificatePath
    ? readFileSync(rootCertificatePath, "utf8")
    : configuredCertificate || undefined;

  // Explicit verification keeps both the CA chain and the database hostname
  // checked. Neither the path nor the certificate contents are logged.
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
}

function errorText(error) {
  return String(error?.message || error || "unknown concurrent index operation error").slice(
    0,
    2000,
  );
}

function indexMatches(operation, index) {
  const normalized = String(index?.index_def || index || "").toLowerCase();
  if (!operation.expectedFragments.every((fragment) => normalized.includes(fragment))) {
    return false;
  }
  if (!index || typeof index === "string") return true;
  return (
    index.access_method === operation.accessMethod &&
    JSON.stringify(index.key_columns || []) === JSON.stringify(operation.keyColumns) &&
    index.is_partial === false &&
    index.has_expressions === false
  );
}

async function readIndex(sql, operation) {
  const rows = await sql`
    select relation.oid::bigint as oid,
           index_row.indisvalid,
           pg_catalog.pg_get_indexdef(relation.oid) as index_def,
           access_method.amname as access_method,
           coalesce(
             (
               select pg_catalog.array_agg(attribute.attname order by key_position.ordinality)
                 from unnest(index_row.indkey) with ordinality as key_position(attnum, ordinality)
                 left join pg_catalog.pg_attribute attribute
                   on attribute.attrelid = index_row.indrelid
                  and attribute.attnum = key_position.attnum
                where key_position.attnum > 0
             ),
             '{}'::text[]
           ) as key_columns,
           index_row.indpred is not null as is_partial,
           index_row.indexprs is not null as has_expressions
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace_row
        on namespace_row.oid = relation.relnamespace
      join pg_catalog.pg_index index_row
        on index_row.indexrelid = relation.oid
      join pg_catalog.pg_class table_relation
        on table_relation.oid = index_row.indrelid
      join pg_catalog.pg_namespace table_namespace
        on table_namespace.oid = table_relation.relnamespace
      join pg_catalog.pg_am access_method
        on access_method.oid = relation.relam
     where namespace_row.nspname = ${operation.schemaName}
       and relation.relname = ${operation.indexName}
       and relation.relkind = 'i'
       and table_namespace.nspname = ${operation.schemaName}
       and table_relation.relname = ${operation.tableName}
  `;
  return rows[0] || null;
}

async function setOperationState(sql, operation, status, lastError = null) {
  await sql`
    update app_private.concurrent_index_operations
       set status = ${status},
           applied_at = case when ${status} = 'applied' then coalesce(applied_at, statement_timestamp()) else applied_at end,
           last_error = ${lastError},
           updated_at = statement_timestamp()
     where operation_key = ${operation.operationKey}
  `;
}

async function applyOperation(sql, operation, row, checkOnly) {
  if (
    row.schema_name !== operation.schemaName ||
    row.table_name !== operation.tableName ||
    row.index_name !== operation.indexName ||
    row.create_sql !== operation.createSql
  ) {
    throw new Error(
      `Allowlist mismatch for ${operation.operationKey}; refusing to execute database-provided SQL.`,
    );
  }

  const existing = await readIndex(sql, operation);
  if (existing && !indexMatches(operation, existing)) {
    throw new Error(
      `Existing index ${operation.indexName} has an unexpected definition; it was not replaced.`,
    );
  }
  if (checkOnly) {
    if (!existing?.indisvalid || !indexMatches(operation, existing)) {
      throw new Error(`Index ${operation.indexName} is missing or invalid in --check mode.`);
    }
    return { status: "applied", existing };
  }

  if (existing && !existing.indisvalid) {
    // A failed concurrent build can leave an invalid index behind. Dropping
    // only that allowlisted index concurrently makes a later retry safe.
    await sql.unsafe(
      `drop index concurrently if exists "${operation.schemaName.replaceAll('"', '""')}"."${operation.indexName.replaceAll('"', '""')}"`,
    );
  }

  await setOperationState(sql, operation, "running");
  if (!existing || !existing.indisvalid) {
    // postgres.js sends this statement in autocommit mode. Do not wrap it in
    // sql.begin(): PostgreSQL rejects CREATE INDEX CONCURRENTLY in a transaction.
    await sql.unsafe(operation.createSql);
  }

  const verified = await readIndex(sql, operation);
  if (!verified?.indisvalid || !indexMatches(operation, verified)) {
    throw new Error(`Index ${operation.indexName} did not pass post-build catalog verification.`);
  }
  await setOperationState(sql, operation, "applied");
  return { status: "applied", existing: verified };
}

async function runConcurrentIndexOperations({
  checkOnly = process.argv.includes("--check"),
  databaseUrl = connectionUrl(),
  clientFactory = postgres,
} = {}) {
  const sessionUrl = withSessionConnectionUrl(databaseUrl);
  let sql;
  const failures = [];
  try {
    sql = clientFactory(sessionUrl, {
      max: 1,
      connect_timeout: Number.parseInt(process.env.PGCONNECT_TIMEOUT || "60", 10),
      ssl: resolveSslOptions(sessionUrl),
    });
    const rows = await sql`
      select operation_key, schema_name, table_name, index_name, create_sql, status
        from app_private.concurrent_index_operations
       where operation_key like '20261008102334:%'
    `;
    const byKey = new Map(rows.map((row) => [String(row.operation_key), row]));
    for (const operation of operations) {
      const row = byKey.get(operation.operationKey);
      if (!row) {
        failures.push(`${operation.operationKey}: operation row is missing`);
        continue;
      }
      try {
        const result = await applyOperation(sql, operation, row, checkOnly);
        console.log(`[concurrent-indexes] ${operation.indexName}: ${result.status}`);
      } catch (error) {
        const message = errorText(error);
        failures.push(`${operation.operationKey}: ${message}`);
        if (!checkOnly) {
          try {
            await setOperationState(sql, operation, "failed", message);
          } catch (stateError) {
            failures.push(
              `${operation.operationKey}: failed-state update: ${errorText(stateError)}`,
            );
          }
        }
        console.error(`[concurrent-indexes] ${operation.indexName}: ${message}`);
      }
    }
  } finally {
    if (sql) await sql.end({ timeout: 5 });
  }

  if (failures.length) {
    throw new Error(`Concurrent index operations failed:\n${failures.join("\n")}`);
  }
}

async function main() {
  await runConcurrentIndexOperations();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}

export {
  applyOperation,
  indexMatches,
  operations,
  resolveSslOptions,
  runConcurrentIndexOperations,
  withSessionConnectionUrl,
};
