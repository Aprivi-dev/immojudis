#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const INFRA_ONLY_PREFIXES = [
  ".github/",
  "docs/",
  "scripts/",
  "services/data-pipeline/",
  "supabase/",
];
const INFRA_ONLY_ROOT_FILES = new Set([
  ".env.example",
  ".gitleaks.toml",
  ".gitleaksignore",
  ".vercelignore",
  "README.md",
]);

function isInfrastructureOnlyPath(path) {
  return (
    INFRA_ONLY_PREFIXES.some((prefix) => path.startsWith(prefix)) || INFRA_ONLY_ROOT_FILES.has(path)
  );
}

function withoutIgnoreCommand(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const copy = { ...value };
  delete copy.ignoreCommand;
  return copy;
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableJson(nested)]),
    );
  }
  return value;
}

function readVercelConfigAtRevision(revision) {
  const raw = execFileSync("git", ["show", `${revision}:vercel.json`], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(raw);
}

function vercelConfigOnlyAddsIgnoreCommand(previousRevision, currentRevision) {
  try {
    const previous = withoutIgnoreCommand(readVercelConfigAtRevision(previousRevision));
    const current = withoutIgnoreCommand(readVercelConfigAtRevision(currentRevision));
    return JSON.stringify(stableJson(previous)) === JSON.stringify(stableJson(current));
  } catch {
    // If the comparison cannot be proven, build. A missing history object must
    // never suppress a real web deployment.
    return false;
  }
}

function changedFiles(previousRevision, currentRevision) {
  const output = execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", previousRevision, currentRevision, "--"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return output
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean);
}

function revisionExists(revision) {
  try {
    execFileSync("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function resolveComparisonRevision(previousRevision, currentRevision) {
  if (previousRevision && revisionExists(previousRevision)) return previousRevision;
  // Vercel's documented ignore-command example compares HEAD^ to HEAD. This
  // fallback also handles a previous production SHA that is not present in a
  // public clone after the release source was reconciled.
  const firstParent = `${currentRevision}^`;
  return revisionExists(firstParent) ? firstParent : null;
}

function shouldIgnoreBuild({
  previousRevision,
  currentRevision = "HEAD",
  files = null,
  vercelConfigOnlyIgnoreCommand = false,
}) {
  if (!previousRevision) return false;
  const paths = files || changedFiles(previousRevision, currentRevision);
  if (!paths.length) return true;
  return paths.every(
    (path) =>
      isInfrastructureOnlyPath(path) || (path === "vercel.json" && vercelConfigOnlyIgnoreCommand),
  );
}

function main() {
  const configuredPreviousRevision = String(process.env.VERCEL_GIT_PREVIOUS_SHA || "").trim();
  const currentRevision = String(process.env.VERCEL_GIT_COMMIT_SHA || "HEAD").trim();
  const previousRevision = resolveComparisonRevision(configuredPreviousRevision, currentRevision);
  if (!previousRevision) {
    console.log("[vercel-ignore-build] No comparable parent revision; build will continue.");
    process.exitCode = 1;
    return;
  }

  try {
    const files = changedFiles(previousRevision, currentRevision);
    const configOnly = files.includes("vercel.json")
      ? vercelConfigOnlyAddsIgnoreCommand(previousRevision, currentRevision)
      : false;
    const ignore = shouldIgnoreBuild({
      previousRevision,
      currentRevision,
      files,
      vercelConfigOnlyIgnoreCommand: configOnly,
    });
    console.log(
      `[vercel-ignore-build] ${ignore ? "Skipping" : "Building"} deployment; ` +
        `changed files: ${files.length}.`,
    );
    process.exitCode = ignore ? 0 : 1;
  } catch (error) {
    console.error(
      `[vercel-ignore-build] Could not prove an infrastructure-only change; building. ${error.message}`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();

export {
  isInfrastructureOnlyPath,
  resolveComparisonRevision,
  shouldIgnoreBuild,
  stableJson,
  vercelConfigOnlyAddsIgnoreCommand,
};
