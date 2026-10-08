#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsDirectory = join(root, "supabase", "migrations");

function collectMigrations(directory = migrationsDirectory) {
  return readdirSync(directory)
    .map((file) => {
      const match = /^(\d{14})_(.+)\.sql$/.exec(file);
      if (!match) return null;
      const path = join(directory, file);
      return {
        version: match[1],
        name: match[2],
        sha256: createHash("sha256")
          .update(canonicalMigrationText(readFileSync(path, "utf8")))
          .digest("hex"),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.version.localeCompare(b.version));
}

function canonicalMigrationText(value) {
  return String(value).replace(/\r\n?/g, "\n").trimEnd();
}

function assertUniqueMigrationVersions(migrations) {
  const seen = new Map();
  for (const migration of migrations) {
    const version = String(migration?.version || "").trim();
    if (!version) throw new Error("Release manifest contains a migration without a version.");
    const previous = seen.get(version);
    if (previous) {
      throw new Error(
        `Release manifest contains duplicate migration version ${version} (${previous} and ${migration.name || "unnamed"}).`,
      );
    }
    seen.set(version, migration.name || "unnamed");
  }
}

function gitValue(args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function buildReleaseManifest({
  env = process.env,
  gitHead = gitValue(["rev-parse", "HEAD"]),
  migrations = collectMigrations(),
  generatedAt = new Date().toISOString(),
  status = "attempted",
  appliedAt = null,
} = {}) {
  const expectedSha = String(env.GITHUB_SHA || "").trim();
  if (expectedSha && gitHead && expectedSha !== gitHead) {
    throw new Error(`Checked-out revision ${gitHead} does not match GITHUB_SHA ${expectedSha}.`);
  }

  if (!migrations.length) throw new Error("No SQL migrations found for the release manifest.");
  if (!["attempted", "applied"].includes(status)) {
    throw new Error(`Unsupported release manifest status: ${status}.`);
  }
  assertUniqueMigrationVersions(migrations);

  const applied = status === "applied";
  const proofTime = appliedAt || generatedAt;

  const migrationDigest = createHash("sha256").update(JSON.stringify(migrations)).digest("hex");

  return {
    manifestVersion: 1,
    generatedAt,
    status,
    attempted: true,
    applied,
    applicationProof: applied
      ? {
          status: "success",
          command: "node scripts/apply-supabase-migrations.mjs",
          recordedAt: proofTime,
        }
      : null,
    repository: env.GITHUB_REPOSITORY || null,
    workflow: env.GITHUB_WORKFLOW || null,
    run: {
      id: env.GITHUB_RUN_ID || null,
      attempt: env.GITHUB_RUN_ATTEMPT || null,
      actor: env.GITHUB_ACTOR || null,
      ref: env.GITHUB_REF || null,
      sha: gitHead || expectedSha || null,
    },
    migrationCount: migrations.length,
    latestMigrationVersion: migrations.at(-1).version,
    migrationDigest,
    migrations,
  };
}

function parseOutputPath(argv) {
  const index = argv.indexOf("--output");
  if (index === -1) return null;
  const output = argv[index + 1];
  if (!output || output.startsWith("-")) {
    throw new Error("--output requires a file path.");
  }
  return resolve(output);
}

function parseStatus(argv) {
  const index = argv.indexOf("--status");
  if (index === -1) return "attempted";
  const status = argv[index + 1];
  if (!status || status.startsWith("-")) throw new Error("--status requires attempted or applied.");
  return status;
}

function main() {
  const argv = process.argv.slice(2);
  const manifest = buildReleaseManifest({ status: parseStatus(argv) });
  const outputPath = parseOutputPath(argv);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (outputPath) {
    writeFileSync(outputPath, serialized, { encoding: "utf8", flag: "wx" });
    console.log(`[release-manifest] Wrote ${outputPath}`);
  } else {
    process.stdout.write(serialized);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();

export {
  assertUniqueMigrationVersions,
  buildReleaseManifest,
  canonicalMigrationText,
  collectMigrations,
};
