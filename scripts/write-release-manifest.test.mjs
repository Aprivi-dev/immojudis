import { describe, expect, it } from "vitest";

import { buildReleaseManifest } from "./write-release-manifest.mjs";

describe("release provenance manifest", () => {
  const migrations = [
    { version: "20261008120000", name: "first", sha256: "a".repeat(64) },
    { version: "20261008130000", name: "second", sha256: "b".repeat(64) },
  ];

  it("records the checked-out commit and migration digest without environment values", () => {
    const manifest = buildReleaseManifest({
      env: {
        GITHUB_REPOSITORY: "Aprivi-dev/immojudis",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: "abc123",
        GITHUB_RUN_ID: "42",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_ACTOR: "release-bot",
        SUPABASE_DB_URL: "postgres://must-never-be-recorded",
      },
      gitHead: "abc123",
      migrations,
      generatedAt: "2026-10-08T10:00:00.000Z",
    });

    expect(manifest).toMatchObject({
      manifestVersion: 1,
      status: "attempted",
      attempted: true,
      applied: false,
      applicationProof: null,
      repository: "Aprivi-dev/immojudis",
      migrationCount: 2,
      latestMigrationVersion: "20261008130000",
      run: {
        ref: "refs/heads/main",
        sha: "abc123",
      },
      migrations,
    });
    expect(JSON.stringify(manifest)).not.toContain("must-never-be-recorded");
    expect(manifest.migrationDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("records proof of application only for the successful status", () => {
    const manifest = buildReleaseManifest({
      env: { GITHUB_SHA: "abc123" },
      gitHead: "abc123",
      migrations,
      generatedAt: "2026-10-08T10:00:00.000Z",
      status: "applied",
    });

    expect(manifest).toMatchObject({
      status: "applied",
      attempted: true,
      applied: true,
      applicationProof: {
        status: "success",
        command: "node scripts/apply-supabase-migrations.mjs",
        recordedAt: "2026-10-08T10:00:00.000Z",
      },
    });
  });

  it("rejects duplicate migration versions instead of producing ambiguous provenance", () => {
    expect(() =>
      buildReleaseManifest({
        migrations: [migrations[0], { ...migrations[1], version: migrations[0].version }],
      }),
    ).toThrow("duplicate migration version");
  });

  it("refuses a checked-out commit different from the workflow SHA", () => {
    expect(() =>
      buildReleaseManifest({
        env: { GITHUB_SHA: "expected" },
        gitHead: "actual",
        migrations,
      }),
    ).toThrow("does not match GITHUB_SHA");
  });
});
