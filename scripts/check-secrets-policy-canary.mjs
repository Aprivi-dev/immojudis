import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const image =
  "ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f";
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const sandbox = mkdtempSync(join(tmpdir(), "immojudis-gitleaks-canary-"));
const reportDir = join(sandbox, "report");
const fixturePath = join(sandbox, "src/lib/information-agent-inbound.ts");
const reportPath = join(reportDir, "dir.json");

try {
  mkdirSync(dirname(fixturePath), { recursive: true });
  mkdirSync(reportDir, { recursive: true });
  copyFileSync(join(root, ".gitleaks.toml"), join(sandbox, ".gitleaks.toml"));
  copyFileSync(join(root, ".gitleaksignore"), join(sandbox, ".gitleaksignore"));

  const newCanaryKey = randomUUID();
  writeFileSync(
    fixturePath,
    `const fixture = { land_surface_m2: 123.45, apiKey: "${newCanaryKey}" };\n`,
  );

  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${sandbox}:/repo:ro`,
      "-v",
      `${reportDir}:/reports`,
      image,
      "dir",
      "/repo",
      "--redact=100",
      "--gitleaks-ignore-path=/repo/.gitleaksignore",
      "--no-banner",
      "--timeout=300",
      "--report-format=json",
      "--report-path=/reports/dir.json",
    ],
    { cwd: root, stdio: "ignore" },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);

  const findings = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].File, "/repo/src/lib/information-agent-inbound.ts");
  assert.equal(findings[0].RuleID, "generic-api-key");
  assert.equal(findings[0].StartLine, 1);
  console.log("Gitleaks same-line canary passed: one new key remained visible.");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
