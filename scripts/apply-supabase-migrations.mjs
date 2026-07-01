#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsDir = join(root, "supabase", "migrations");

for (const file of [".env", ".env.local", ".env.production", ".env.production.local"]) {
  const path = join(root, file);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]] == null) process.env[match[1]] = unquote(match[2].trim());
  }
}

const dbUrl = process.env.SUPABASE_DB_URL;
const dryRun = process.argv.includes("--dry-run");

if (!dbUrl) {
  console.error("[supabase-migrations] SUPABASE_DB_URL is required.");
  process.exit(1);
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

const remoteVersions = new Set(
  psql([
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
  psql(["--set=ON_ERROR_STOP=1", "--file", migration.path], { inherit: true });
  recordMigration(migration);
}

console.log("[supabase-migrations] Applied all pending migrations.");

function recordMigration(migration) {
  const statement = `
insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
values (${sqlLiteral(migration.version)}, ${sqlLiteral(migration.name)}, ${sqlArray([readFileSync(migration.path, "utf8")])}, 'github-actions')
on conflict (version) do nothing;
`;
  psql(["--set=ON_ERROR_STOP=1", "--command", statement]);
}

function psql(args, options = {}) {
  const result = spawnSync("psql", [dbUrl, ...args], {
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

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlArray(values) {
  return `array[${values.map(sqlLiteral).join(", ")}]::text[]`;
}

function unquote(value) {
  return value.replace(/^(['"])(.*)\1$/, "$2");
}
