import { describe, expect, it, vi } from "vitest";

import { REQUIRED_CI_CHECKS, evaluateCiChecks, main } from "./check-commit-ci-green.mjs";

function run(name, overrides = {}) {
  return {
    id: 1,
    name,
    status: "completed",
    conclusion: "success",
    app: { slug: "github-actions" },
    ...overrides,
  };
}

const allGreen = () => REQUIRED_CI_CHECKS.map((name, index) => run(name, { id: index + 1 }));

describe("evaluateCiChecks", () => {
  it("accepts a commit whose CI checks are all successful", () => {
    expect(evaluateCiChecks(allGreen())).toEqual({ ok: true, problems: [] });
  });

  it("ignores checks that are not required (CodeQL, graph update, skipped dependency review)", () => {
    const extra = [
      run("Analyze (python)", { id: 100, conclusion: "failure" }),
      run("Dependency review", { id: 101, conclusion: "skipped" }),
    ];
    expect(evaluateCiChecks([...allGreen(), ...extra]).ok).toBe(true);
  });

  it("refuses a failed, cancelled or skipped required check", () => {
    for (const conclusion of ["failure", "cancelled", "skipped", "timed_out", null]) {
      const checks = allGreen();
      checks[2] = { ...checks[2], conclusion };
      const result = evaluateCiChecks(checks);
      expect(result.ok).toBe(false);
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]).toContain(REQUIRED_CI_CHECKS[2]);
    }
  });

  it("refuses a required check that is still running or absent", () => {
    const running = allGreen();
    running[0] = { ...running[0], status: "in_progress", conclusion: null };
    expect(evaluateCiChecks(running).problems).toEqual([
      `${REQUIRED_CI_CHECKS[0]}: not finished (in_progress)`,
    ]);

    const absent = allGreen().slice(1);
    expect(evaluateCiChecks(absent).problems).toEqual([
      `${REQUIRED_CI_CHECKS[0]}: absent (CI not started for this commit)`,
    ]);
    expect(evaluateCiChecks([]).problems).toHaveLength(REQUIRED_CI_CHECKS.length);
  });

  it("judges a re-run by its newest attempt only", () => {
    const failedThenFixed = [
      run("Supabase migrations + pgTAP", { id: 10, conclusion: "failure" }),
      ...allGreen().map((check) => ({ ...check, id: check.id + 20 })),
    ];
    expect(evaluateCiChecks(failedThenFixed).ok).toBe(true);

    const greenThenRerunFailed = [
      ...allGreen(),
      run("Supabase migrations + pgTAP", { id: 500, conclusion: "failure" }),
    ];
    expect(evaluateCiChecks(greenThenRerunFailed).ok).toBe(false);
  });

  it("does not trust a green check posted by another application", () => {
    const forged = allGreen().map((check) => ({ ...check, app: { slug: "someone-else" } }));
    expect(evaluateCiChecks(forged).ok).toBe(false);
  });
});

describe("main", () => {
  const env = { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "owner/repo", GITHUB_SHA: "a".repeat(40) };

  function respond(body, status = 200) {
    return vi.fn(async () => ({ ok: status < 400, status, json: async () => body }));
  }

  it("exits 0 when CI is green and 1 otherwise, reading the commit's check runs", async () => {
    const green = respond({ check_runs: allGreen() });
    expect(await main(env, green)).toBe(0);
    const [url, init] = green.mock.calls[0];
    expect(url).toContain("/repos/owner/repo/commits/" + "a".repeat(40) + "/check-runs");
    expect(init.headers.Authorization).toBe("Bearer t");

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(env, respond({ check_runs: allGreen().slice(1) }))).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("::error title=CI not green on aaaaaaa");
    error.mockRestore();
  });

  it("fails closed when the API cannot be read or the environment is incomplete", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(env, respond({}, 403))).toBe(1);
    expect(await main({ ...env, GITHUB_TOKEN: "" }, respond({ check_runs: allGreen() }))).toBe(1);
    error.mockRestore();
  });

  it("follows pagination", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => run(`Other ${i}`, { id: 1000 + i }));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ check_runs: page1 }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ check_runs: allGreen() }),
      });
    expect(await main(env, fetchImpl)).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
