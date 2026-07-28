#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsDir = join(root, "supabase", "migrations");
const initialEnv = new Set(
  Object.keys(process.env).filter((name) => !isMissing(process.env[name])),
);

for (const file of [
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
  ".env.vercel-production.local",
]) {
  const path = join(root, file);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (!match || initialEnv.has(match[1])) continue;
    const value = unquote(match[2].trim());
    if (!isMissing(value) || isMissing(process.env[match[1]])) process.env[match[1]] = value;
  }
}

const databaseConnectTimeoutSeconds = Math.min(
  900,
  Math.max(15, Number.parseInt(process.env.PGCONNECT_TIMEOUT || "60", 10) || 60),
);
const databaseConnectRetries = Math.min(
  60,
  Math.max(1, Number.parseInt(process.env.SUPABASE_MIGRATION_CONNECT_RETRIES || "1", 10) || 1),
);
const databaseRetryDelaySeconds = Math.min(
  60,
  Math.max(5, Number.parseInt(process.env.SUPABASE_MIGRATION_RETRY_DELAY || "15", 10) || 15),
);

const runOnlyIfEnabled = process.argv.includes("--if-enabled");
const dryRun = process.argv.includes("--dry-run");
const checkOnly = process.argv.includes("--check");

if (runOnlyIfEnabled && !isTruthy(process.env.RUN_SUPABASE_MIGRATIONS_ON_BUILD)) {
  console.log("[supabase-migrations] Skipped; RUN_SUPABASE_MIGRATIONS_ON_BUILD is not enabled.");
  process.exit(0);
}

const migrations = readdirSync(migrationsDir)
  .map((file) => {
    const match = /^(\d{14})_(.+)\.sql$/.exec(file);
    if (!match) return null;
    return {
      file,
      path: join(migrationsDir, file),
      version: match[1],
      name: match[2],
    };
  })
  .filter(Boolean)
  .sort((a, b) => a.version.localeCompare(b.version));

if (!migrations.length) {
  console.error("[supabase-migrations] No migration files found.");
  process.exit(1);
}

const migrationsByVersion = Map.groupBy(migrations, (migration) => migration.version);
const duplicateVersions = [...migrationsByVersion.entries()].filter(
  ([, versionMigrations]) => versionMigrations.length > 1,
);

if (duplicateVersions.length) {
  console.error("[supabase-migrations] Duplicate local migration versions detected:");
  for (const [version, versionMigrations] of duplicateVersions) {
    console.error(`  - ${version}: ${versionMigrations.map(({ file }) => file).join(", ")}`);
  }
  console.error("[supabase-migrations] Assign one unique timestamp to every migration.");
  process.exit(1);
}

if (checkOnly) {
  console.log(
    `[supabase-migrations] ${migrations.length} migration files have unique local versions.`,
  );
  process.exit(0);
}

const dbUrl = firstFilledEnv(
  process.env.SUPABASE_DB_URL,
  process.env.POSTGRES_URL_NON_POOLING,
  process.env.POSTGRES_URL,
);

if (!dbUrl) {
  console.error(
    "[supabase-migrations] SUPABASE_DB_URL, POSTGRES_URL_NON_POOLING or POSTGRES_URL is required.",
  );
  process.exit(1);
}

const runner = await createRunner(dbUrl);

const remoteVersions = new Set(await runner.listAppliedVersions());

const localVersions = new Set(migrations.map((migration) => migration.version));
const remoteOnly = [...remoteVersions].filter((version) => !localVersions.has(version));
if (remoteOnly.length) {
  console.error(
    "[supabase-migrations] Remote migration history contains versions missing locally:",
  );
  for (const version of remoteOnly) console.error(`  - ${version}`);
  console.error("[supabase-migrations] Add the missing local migration file(s) before applying.");
  process.exit(1);
}

const pending = migrations.filter((migration) => !remoteVersions.has(migration.version));
if (!pending.length) {
  console.log("[supabase-migrations] Remote migration history is up to date.");
  process.exit(0);
}

console.log(`[supabase-migrations] Pending migrations: ${pending.map((m) => m.file).join(", ")}`);
if (dryRun) {
  console.log("[supabase-migrations] Dry run complete; no SQL was applied.");
  process.exit(0);
}

for (const migration of pending) {
  console.log(`[supabase-migrations] Applying ${migration.file}`);
  await runner.applyFile(migration.path);
  await recordMigration(runner, migration);
}

console.log("[supabase-migrations] Applied all pending migrations.");
await runner.close();

async function recordMigration(runner, migration) {
  const statement = `
insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
values (${sqlLiteral(migration.version)}, ${sqlLiteral(migration.name)}, ${sqlArray([readFileSync(migration.path, "utf8")])}, 'github-actions')
on conflict (version) do nothing;
`;
  await runner.command(statement);
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlArray(values) {
  return `array[${values.map(sqlLiteral).join(", ")}]::text[]`;
}

function unquote(value) {
  return value.replace(/^(['"])(.*)\1$/, "$2");
}

function firstFilledEnv(...values) {
  return values.find((value) => !isMissing(value))?.trim();
}

function isMissing(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return (
    !normalized ||
    normalized.startsWith("your-") ||
    ["changeme", "placeholder", "todo", "null", "undefined"].includes(normalized)
  );
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

async function createRunner(dbUrl) {
  const requestedRunner = String(process.env.SUPABASE_MIGRATION_RUNNER || "auto")
    .trim()
    .toLowerCase();

  if (requestedRunner === "postgres-js") return createPostgresJsRunner(dbUrl);

  if (!["auto", "psql"].includes(requestedRunner)) {
    throw new Error(
      `[supabase-migrations] Unsupported SUPABASE_MIGRATION_RUNNER: ${requestedRunner}`,
    );
  }

  const psqlBin = resolvePsqlBin();
  if (psqlBin) return createPsqlRunner(dbUrl, psqlBin);
  if (requestedRunner === "psql") {
    throw new Error("[supabase-migrations] psql runner requested but psql is unavailable.");
  }
  return createPostgresJsRunner(dbUrl);
}

function createPsqlRunner(dbUrl, psqlBin) {
  const connectionUrl = withDatabaseConnectTimeout(dbUrl);
  console.log(`[supabase-migrations] Using psql runner: ${psqlBin}`);
  return {
    listAppliedVersions() {
      return Promise.resolve(
        psql(connectionUrl, psqlBin, [
          "--tuples-only",
          "--no-align",
          "--command",
          "select version from supabase_migrations.schema_migrations order by version;",
        ])
          .stdout.trim()
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      );
    },
    applyFile(path) {
      psql(connectionUrl, psqlBin, ["--set=ON_ERROR_STOP=1", "--file", path], { inherit: true });
      return Promise.resolve();
    },
    command(statement) {
      psql(connectionUrl, psqlBin, ["--set=ON_ERROR_STOP=1", "--command", statement]);
      return Promise.resolve();
    },
    close() {
      return Promise.resolve();
    },
  };
}

async function createPostgresJsRunner(dbUrl) {
  const { default: postgres } = await import("postgres");
  const sql = postgres(withSessionPooler(dbUrl), {
    max: 1,
    connect_timeout: databaseConnectTimeoutSeconds,
    ssl: process.env.POSTGRES_SSL === "disable" ? false : "require",
  });

  console.log("[supabase-migrations] Using Postgres.js runner.");

  return {
    async listAppliedVersions() {
      const rows = await retryTransientConnection(async () => {
        await sql`set statement_timeout = 0`;
        return sql`
          select version
          from supabase_migrations.schema_migrations
          order by version
        `;
      });
      return rows.map((row) => String(row.version).trim()).filter(Boolean);
    },
    async applyFile(path) {
      await sql.unsafe(readFileSync(path, "utf8"));
    },
    async command(statement) {
      await sql.unsafe(statement);
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

async function retryTransientConnection(operation) {
  for (let attempt = 1; attempt <= databaseConnectRetries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= databaseConnectRetries || !isTransientConnectionError(error)) throw error;
      console.warn(
        `[supabase-migrations] Database unavailable; retrying connection in ${databaseRetryDelaySeconds}s (${attempt}/${databaseConnectRetries}).`,
      );
      await new Promise((resolve) => setTimeout(resolve, databaseRetryDelaySeconds * 1000));
    }
  }
}

function isTransientConnectionError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();
  return (
    code.startsWith("08") ||
    ["53300", "57P03", "ECONNRESET", "ETIMEDOUT"].includes(code) ||
    message.includes("authentication query failed") ||
    message.includes("echeckouttimeout") ||
    message.includes("unable to check out connection from the pool") ||
    message.includes("connection to database not available") ||
    message.includes("connection terminated due to connection timeout") ||
    message.includes("circuit breaker open")
  );
}

function withSessionPooler(dbUrl) {
  const url = new URL(dbUrl);
  if (url.hostname.endsWith(".pooler.supabase.com")) {
    url.port = "5432";
  }
  return url.toString();
}

function psql(dbUrl, psqlBin, args, options = {}) {
  const result = spawnSync(psqlBin, [dbUrl, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PGCONNECT_TIMEOUT: String(databaseConnectTimeoutSeconds),
    },
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    if (!options.inherit) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    process.exit(result.status ?? 1);
  }

  return result;
}

function withDatabaseConnectTimeout(dbUrl) {
  const url = new URL(dbUrl);
  url.searchParams.set("connect_timeout", String(databaseConnectTimeoutSeconds));
  return url.toString();
}

function resolvePsqlBin() {
  const candidates = [
    process.env.PSQL_BIN,
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/usr/local/opt/libpq/bin/psql",
  ].filter(Boolean);

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0) return candidate;
  }
  return undefined;
}
