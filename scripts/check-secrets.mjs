import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, relative } from "node:path";

const image =
  "ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f";
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const immutableFixtureSha256 = new Map([
  [
    "docs/audits/sources-2026-10-02/primary/licitor-109932.html",
    "c98c0a37af9812f36e02268080eaed3b6aff8a9afcdc0f89ed7dcd9b90370fcc",
  ],
  [
    "docs/audits/sources-2026-10-02/primary/licitor-list.html",
    "53fd2a85cdfcd11b91d62749f0791aacb914953ae7fb10b924a2d3f66e710ce5",
  ],
  [
    "docs/audits/sources-2026-10-02/primary/licitor-110031.html",
    "778ad8a5a1e007403c4ccc7216cebc09c3db1dab6302e30628414b03982f9e2f",
  ],
  [
    "docs/audits/sources-2026-10-02/secondary/responses/info-6051-response.html",
    "2f0400b3d193edcd6f7ff8e26b39b3482a09ea9b72ccbe84169ee453b17a68b5",
  ],
  [
    "docs/audits/sources-2026-10-02/secondary/responses/info-6053-response.html",
    "a93f01131c32c65b603bf6736c11bd3700fab18428c67254eb7236aa9dfa4322",
  ],
  [
    "docs/audits/sources-2026-10-02/secondary/responses/info-list-response.html",
    "42dd472b648bb78db5f60b5b9284f22a773e693a6b3855cf4f9d447d10464e29",
  ],
  [
    "docs/audits/sources-2026-10-02/secondary/responses/petites-165934-response.html",
    "af678113ea7b5de267043e853356633082d9c60dc607be9292dcba80c3ee36b5",
  ],
  [
    "docs/audits/sources-2026-10-02/secondary/responses/petites-165875-response.html",
    "6a45e2bc51e3dbcf1c03efef76677ef0dcaaa1dc4bbef2fc0f8d81adeab82c94",
  ],
  [
    "docs/audits/sources-2026-10-02/secondary/responses/petites-list-response.html",
    "fe6b9292b2c46568c226e560f024ce8bbe74554627e16f2b9e9a519bbd1687a7",
  ],
  [
    "docs/audits/sources-2026-10-02/secondary/responses/agrasc-evry-2075541-response.html",
    "592fd9bc37c06d0450e3231e5df43f47e04a6b4bd3ed5291e5c738b1ca0362bb",
  ],
  [
    "docs/audits/sources-2026-10-02/dynamic/clean/notaires-public-2074289-bordeaux-dom.html",
    "3d5349b35a0c8dcdd484e718bd9b8bf11276e3b68aaf80e4aeb783d429d24383",
  ],
  [
    "docs/audits/sources-2026-10-02/dynamic/clean/notaires-public-2074289-bordeaux-response.html",
    "600a6c8cc373c8b46a1ef6744d0553855789709c42df234fe4aa2771df2bd21a",
  ],
  [
    "docs/audits/sources-2026-10-02/dynamic/clean/notaires-public-2083008-arcachon-dom.html",
    "06182ed381c13eaaf106162bfc1675a5a52edfbca68c10cd861e259c89cd3fb0",
  ],
  [
    "docs/audits/sources-2026-10-02/dynamic/clean/notaires-public-2083008-arcachon-response.html",
    "c45513b44472c1a78a0c6de423ed54088a5439039c9184b09295519fd4dba9a6",
  ],
]);
for (const [path, expected] of immutableFixtureSha256) {
  const source = resolve(root, path);
  let stat;
  try {
    stat = lstatSync(source);
  } catch (error) {
    // Releases may omit the public audit captures; without a file there is no
    // current path/line fingerprint for this entry to hide.
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  if (!stat.isFile()) continue;
  const actual = createHash("sha256").update(readFileSync(source)).digest("hex");
  if (actual !== expected) throw new Error(`Immutable secret-scan fixture changed: ${path}`);
}
if (
  execFileSync("git", ["rev-parse", "--is-shallow-repository"], { encoding: "utf8" }).trim() ===
  "true"
) {
  throw new Error("Full Git history required: use checkout fetch-depth: 0.");
}
const reportDir = process.argv[2] ? resolve(process.argv[2]) : null;
if (reportDir) mkdirSync(reportDir, { recursive: true, mode: 0o700 });
const snapshot = mkdtempSync(join(tmpdir(), "immojudis-secret-scan-"));
try {
  const paths = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
  for (const path of new Set(paths)) {
    const source = resolve(root, path);
    if (relative(root, source).startsWith("..")) throw new Error("Invalid repository path");
    let stat;
    try {
      stat = lstatSync(source);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile()) continue;
    const target = join(snapshot, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  for (const [mode, source, extra] of [
    ["git", root, ["--log-opts=--all"]],
    ["dir", snapshot, []],
  ]) {
    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "-v",
        `${source}:/repo:ro`,
        ...(reportDir ? ["-v", `${reportDir}:/reports`] : []),
        image,
        mode,
        "/repo",
        ...extra,
        "--redact=100",
        "--gitleaks-ignore-path=/repo/.gitleaksignore",
        "--no-banner",
        "--timeout=300",
        ...(reportDir ? ["--report-format=json", `--report-path=/reports/${mode}.json`] : []),
      ],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status || 1;
    }
  }
} finally {
  rmSync(snapshot, { recursive: true, force: true });
}
