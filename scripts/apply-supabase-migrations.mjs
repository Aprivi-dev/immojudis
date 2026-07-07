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

const runOnlyIfEnabled = process.argv.includes("--if-enabled");
const dryRun = process.argv.includes("--dry-run");

if (runOnlyIfEnabled && !isTruthy(process.env.RUN_SUPABASE_MIGRATIONS_ON_BUILD)) {
  console.log("[supabase-migrations] Skipped; RUN_SUPABASE_MIGRATIONS_ON_BUILD is not enabled.");
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
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}

function isMissing(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return (
    !normalized ||
    normalized.startsWith("your-") ||
    ["changeme", "todo", "null", "undefined"].includes(normalized)
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
  const psqlBin = resolvePsqlBin();
  if (psqlBin) return createPsqlRunner(dbUrl, psqlBin);
  return createPostgresJsRunner(dbUrl);
}

function createPsqlRunner(dbUrl, psqlBin) {
  console.log(`[supabase-migrations] Using psql runner: ${psqlBin}`);
  return {
    listAppliedVersions() {
      return Promise.resolve(
        psql(dbUrl, psqlBin, [
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
      psql(dbUrl, psqlBin, ["--set=ON_ERROR_STOP=1", "--file", path], { inherit: true });
      return Promise.resolve();
    },
    command(statement) {
      psql(dbUrl, psqlBin, ["--set=ON_ERROR_STOP=1", "--command", statement]);
      return Promise.resolve();
    },
    close() {
      return Promise.resolve();
    },
  };
}

async function createPostgresJsRunner(dbUrl) {
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
    max: 1,
    ssl: process.env.POSTGRES_SSL === "disable" ? false : "require",
  });

  console.log("[supabase-migrations] Using Postgres.js runner.");

  return {
    async listAppliedVersions() {
      const rows = await sql`
        select version
        from supabase_migrations.schema_migrations
        order by version
      `;
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

function psql(dbUrl, psqlBin, args, options = {}) {
  const result = spawnSync(psqlBin, [dbUrl, ...args], {
    cwd: root,
    encoding: "utf8",
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
