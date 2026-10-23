#!/usr/bin/env node

// Refuses a production migration run when the CI checks of the commit are not all green.
//
// Read-only: it lists the check runs of GITHUB_SHA through the GitHub API with the workflow
// GITHUB_TOKEN (permission `checks: read` only) and exits non-zero unless every job of
// .github/workflows/ci.yml that runs on a push to main has finished with `success`. A check that is
// missing, still running, failed, cancelled or skipped blocks the run: the owner waits for CI, or
// re-runs it, then dispatches the migration workflow again.

import { fileURLToPath } from "node:url";

// Names of the jobs of ci.yml that run on a push to main (all but the pull-request-only dependency
// review). services/data-pipeline/tests/test_ci_workflow.py keeps this list equal to ci.yml.
export const REQUIRED_CI_CHECKS = [
  "Single-scheduler data collection invariant",
  "Web — typecheck",
  "Web — lint",
  "Web — unit tests and security invariants",
  "Web — dependency audit and secret scan",
  "Web — production build and budgets",
  "Web (typecheck + lint)",
  "Data pipeline (Python 3.11)",
  "Data pipeline (Python 3.12)",
  "Supabase migrations + pgTAP",
  "Investor journey (Playwright)",
];

const GITHUB_ACTIONS_APP = "github-actions";

// Newest check run per name among those created by GitHub Actions (a re-run supersedes the
// previous attempt; checks posted by other apps are not CI jobs).
function latestRunsByName(checkRuns) {
  const latest = new Map();
  for (const run of checkRuns) {
    if (run?.app?.slug !== GITHUB_ACTIONS_APP || typeof run.name !== "string") continue;
    const previous = latest.get(run.name);
    if (!previous || Number(run.id) > Number(previous.id)) latest.set(run.name, run);
  }
  return latest;
}

/**
 * @param {Array<object>} checkRuns check runs of the commit, as returned by the GitHub API
 * @param {readonly string[]} required names of the checks that must be green
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function evaluateCiChecks(checkRuns, required = REQUIRED_CI_CHECKS) {
  const latest = latestRunsByName(Array.isArray(checkRuns) ? checkRuns : []);
  const problems = [];
  for (const name of required) {
    const run = latest.get(name);
    if (!run) {
      problems.push(`${name}: absent (CI not started for this commit)`);
    } else if (run.status !== "completed") {
      problems.push(`${name}: not finished (${run.status})`);
    } else if (run.conclusion !== "success") {
      problems.push(`${name}: ${run.conclusion ?? "no conclusion"}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

async function listCheckRuns({ repository, sha, token, fetchImpl = fetch }) {
  const runs = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}/commits/${sha}/check-runs?per_page=100&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub API answered ${response.status} while listing the checks of ${sha}.`);
    }
    const body = await response.json();
    const batch = Array.isArray(body.check_runs) ? body.check_runs : [];
    runs.push(...batch);
    if (batch.length < 100) return runs;
  }
  throw new Error(`More than 1000 check runs on ${sha}; refusing to guess.`);
}

export async function main(env = process.env, fetchImpl = fetch) {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository, GITHUB_SHA: sha } = env;
  if (!token || !repository || !sha) {
    console.error("::error::GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_SHA are required.");
    return 1;
  }
  let runs;
  try {
    runs = await listCheckRuns({ repository, sha, token, fetchImpl });
  } catch (error) {
    // Fail closed: if CI cannot be read, the migrations are not applied.
    console.error(`::error title=CI checks unreadable::${error.message}`);
    return 1;
  }
  const { ok, problems } = evaluateCiChecks(runs);
  if (!ok) {
    console.error(
      `::error title=CI not green on ${sha.slice(0, 7)}::Production migrations refused: ${problems.join("; ")}`,
    );
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("Wait for the CI run of this commit (or re-run it), then dispatch again.");
    return 1;
  }
  console.log(`All ${REQUIRED_CI_CHECKS.length} CI checks are green on ${sha}.`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
