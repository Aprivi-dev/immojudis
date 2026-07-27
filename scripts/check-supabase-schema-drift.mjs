#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
loadEnvironmentFiles(root);

const remote = process.argv.includes("--remote");
const target = remote
  ? firstFilledEnv(
      process.env.SUPABASE_DB_URL,
      process.env.POSTGRES_URL_NON_POOLING,
      process.env.POSTGRES_URL,
    )
  : "local";

if (!target) {
  console.error("[schema-drift] A direct Postgres URL is required for --remote.");
  process.exit(1);
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), "immojudis-schema-drift-"));
const outputPath = join(temporaryDirectory, "drift.sql");

try {
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(
    executable,
    [
      "--yes",
      "supabase@2.110.0",
      "db",
      "diff",
      "--from",
      "migrations",
      "--to",
      target,
      "--schema",
      "public,app_private",
      `--output=${outputPath}`,
      "--log-level",
      "error",
    ],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  const diff = existsSync(outputPath) ? readFileSync(outputPath, "utf8").trim() : "";
  if (diff) {
    console.error(
      `[schema-drift] ${remote ? "Production" : "Local database"} differs from committed migrations.`,
    );
    console.error(diff.slice(0, 4_000));
    process.exit(1);
  }

  console.log(
    `[schema-drift] ${remote ? "Production" : "Local database"} matches committed migrations.`,
  );
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

function loadEnvironmentFiles(directory) {
  const initialEnvironment = new Set(
    Object.keys(process.env).filter((name) => !isMissing(process.env[name])),
  );
  for (const file of [
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
    ".env.vercel-production.local",
  ]) {
    const path = join(directory, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
      if (!match || initialEnvironment.has(match[1])) continue;
      const value = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
      if (!isMissing(value)) process.env[match[1]] = value;
    }
  }
}

function firstFilledEnv(...values) {
  return values.find((value) => !isMissing(value))?.trim();
}

function isMissing(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return (
    !normalized || ["changeme", "placeholder", "todo", "null", "undefined"].includes(normalized)
  );
}
