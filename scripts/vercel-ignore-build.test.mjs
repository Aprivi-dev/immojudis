import { describe, expect, it } from "vitest";

import {
  isInfrastructureOnlyPath,
  resolveComparisonRevision,
  shouldIgnoreBuild,
} from "./vercel-ignore-build.mjs";

describe("Vercel ignored build step", () => {
  it("ignores CI, worker, migration, and audit removals", () => {
    expect(
      shouldIgnoreBuild({
        previousRevision: "previous",
        files: [
          ".github/workflows/ci.yml",
          "services/data-pipeline/src/queued_runner.py",
          "supabase/migrations/20261008120000_fixture.sql",
          "docs/audits/old-report.json",
          "scripts/write-release-manifest.mjs",
        ],
      }),
    ).toBe(true);
  });

  it("builds when application or dependency input changes", () => {
    expect(
      shouldIgnoreBuild({
        previousRevision: "previous",
        files: ["src/app/page.tsx", "package-lock.json"],
      }),
    ).toBe(false);
  });

  it("allows the initial ignoreCommand addition to be ignored", () => {
    expect(
      shouldIgnoreBuild({
        previousRevision: "previous",
        files: ["vercel.json", ".github/workflows/ci.yml"],
        vercelConfigOnlyIgnoreCommand: true,
      }),
    ).toBe(true);
  });

  it("falls back to the current commit parent when the previous deployment SHA is unavailable", () => {
    expect(
      shouldIgnoreBuild({ previousRevision: "", files: ["services/data-pipeline/src/main.py"] }),
    ).toBe(false);
  });

  it("exports the comparison fallback used by the Vercel command", () => {
    expect(resolveComparisonRevision("previous", "current")).toBe(null);
  });

  it("does not classify root application inputs as infrastructure-only", () => {
    expect(isInfrastructureOnlyPath("next.config.mjs")).toBe(false);
    expect(isInfrastructureOnlyPath("package.json")).toBe(false);
    expect(isInfrastructureOnlyPath("src/lib/supabase.ts")).toBe(false);
  });
});
