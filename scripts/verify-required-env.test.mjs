import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { legalConfigurationStatus } from "../src/lib/legal-documents";
import {
  blockingLaunchProblems,
  EXPLICIT_SITE_URL_ENV_NAMES,
  LEGAL_ENV_NAMES,
  evaluateProductionLaunchConfig,
  productionLaunchProblems,
} from "./lib/launch-config.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
// The scripts read .env files from the working directory: run them in an empty one.
const emptyCwd = mkdtempSync(join(tmpdir(), "immojudis-env-"));
afterAll(() => rmSync(emptyCwd, { recursive: true, force: true }));

const supabase = {
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
};
const legal = Object.fromEntries(LEGAL_ENV_NAMES.map((name) => [name, "renseigné"]));
const completeLaunch = {
  ...supabase,
  ...legal,
  ADMIN_MFA_REQUIRED: "true",
  SITE_URL: "https://immojudis.com",
};

function runBuildCheck(env) {
  const result = spawnSync(process.execPath, [join(scriptsDir, "verify-required-env.mjs")], {
    cwd: emptyCwd,
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("garde-fous de lancement (build de production)", () => {
  it("liste les mêmes mentions légales que src/lib/legal-documents.ts", () => {
    expect([...LEGAL_ENV_NAMES].sort()).toEqual([...legalConfigurationStatus({}).missing].sort());
  });

  it("ne compte pas VERCEL_URL comme origine canonique explicite", () => {
    expect(EXPLICIT_SITE_URL_ENV_NAMES).not.toContain("VERCEL_URL");
    const env = { ...completeLaunch, SITE_URL: "", VERCEL_URL: "x.app" };
    expect(productionLaunchProblems(env)).toEqual([]);
    const problems = blockingLaunchProblems(env);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/origine canonique/);
  });

  it("ne vérifie rien hors production", () => {
    expect(evaluateProductionLaunchConfig({ VERCEL_ENV: "preview" })).toEqual({
      exitCode: 0,
      errors: [],
      warnings: [],
    });
    expect(evaluateProductionLaunchConfig({})).toMatchObject({ exitCode: 0 });
  });

  it("bloque le build de production si une mention légale manque", () => {
    const { NEXT_PUBLIC_LEGAL_CONTACT_PHONE: _omitted, ...withoutPhone } = completeLaunch;
    const result = runBuildCheck({ ...withoutPhone, VERCEL_ENV: "production" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("NEXT_PUBLIC_LEGAL_CONTACT_PHONE");
    expect(result.stderr).not.toContain("NEXT_PUBLIC_LEGAL_ENTITY_NAME");
  });

  it("bloque le build de production sans ADMIN_MFA_REQUIRED=true", () => {
    for (const value of [undefined, "false", "1"]) {
      const env = { ...completeLaunch, VERCEL_ENV: "production" };
      if (value === undefined) delete env.ADMIN_MFA_REQUIRED;
      else env.ADMIN_MFA_REQUIRED = value;
      const result = runBuildCheck(env);
      expect(result.status, `ADMIN_MFA_REQUIRED=${value}`).toBe(1);
      expect(result.stderr).toContain("ADMIN_MFA_REQUIRED");
    }
  });

  it("bloque le build de production avec la seule origine VERCEL_URL", () => {
    const { SITE_URL: _omitted, ...withoutSiteUrl } = completeLaunch;
    const result = runBuildCheck({
      ...withoutSiteUrl,
      VERCEL_ENV: "production",
      VERCEL_URL: "immojudis-abc123.vercel.app",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/origine canonique/);
  });

  it("laisse passer un build de production complet", () => {
    const result = runBuildCheck({ ...completeLaunch, VERCEL_ENV: "production" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("laisse passer un build de preview incomplet", () => {
    const result = runBuildCheck({ ...supabase, VERCEL_ENV: "preview" });
    expect(result.status).toBe(0);
  });

  it("transforme les erreurs en avertissements avec ALLOW_INCOMPLETE_LAUNCH_CONFIG=true", () => {
    const result = runBuildCheck({
      ...supabase,
      VERCEL_ENV: "production",
      SITE_URL: "https://immojudis.com",
      ALLOW_INCOMPLETE_LAUNCH_CONFIG: "true",
    });
    expect(result.status).toBe(0);
    // console.warn écrit sur stderr : l'avertissement est visible, sans message de blocage.
    expect(result.stderr).toContain("ATTENTION : ALLOW_INCOMPLETE_LAUNCH_CONFIG=true");
    expect(result.stderr).not.toContain("bloqué");
    // Seule la valeur exacte « true » ouvre l'échappatoire.
    const refused = runBuildCheck({
      ...supabase,
      VERCEL_ENV: "production",
      SITE_URL: "https://immojudis.com",
      ALLOW_INCOMPLETE_LAUNCH_CONFIG: "yes",
    });
    expect(refused.status).toBe(1);
  });

  it("l'échappatoire ne couvre pas l'absence d'origine canonique", () => {
    const outcome = evaluateProductionLaunchConfig({
      ...supabase,
      VERCEL_ENV: "production",
      ALLOW_INCOMPLETE_LAUNCH_CONFIG: "true",
    });
    expect(outcome.exitCode).toBe(1);
    const text = outcome.errors.join("\n");
    expect(text).toContain("origine canonique");
    expect(text).toContain("ne peut pas être contournée");
  });

  it("l'échappatoire affiche chaque problème en avertissement", () => {
    const outcome = evaluateProductionLaunchConfig({
      ...supabase,
      VERCEL_ENV: "production",
      SITE_URL: "https://immojudis.com",
      ALLOW_INCOMPLETE_LAUNCH_CONFIG: "true",
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.errors).toEqual([]);
    const text = outcome.warnings.join("\n");
    expect(text).toContain("ATTENTION");
    expect(text).toContain("NEXT_PUBLIC_LEGAL_ENTITY_NAME");
    expect(text).toContain("ADMIN_MFA_REQUIRED");
  });

  it("l'échappatoire ne change rien quand la configuration est complète", () => {
    expect(
      evaluateProductionLaunchConfig({
        ...completeLaunch,
        VERCEL_ENV: "production",
        ALLOW_INCOMPLETE_LAUNCH_CONFIG: "true",
      }),
    ).toEqual({ exitCode: 0, errors: [], warnings: [] });
  });
});

describe("verify-production-env.mjs", () => {
  it("n'accepte plus VERCEL_URL comme origine canonique", () => {
    const run = (extra) =>
      spawnSync(process.execPath, [resolve(scriptsDir, "verify-production-env.mjs")], {
        cwd: emptyCwd,
        env: {
          PATH: process.env.PATH,
          ...supabase,
          SUPABASE_SECRET_KEY: "sb_secret_test",
          SUPABASE_DB_URL: "postgres://localhost/postgres",
          CRON_SECRET: "cron",
          NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN: "pk.abc.def",
          ...extra,
        },
        encoding: "utf8",
      });

    const vercelOnly = run({ VERCEL_URL: "immojudis-abc123.vercel.app" });
    expect(vercelOnly.status).toBe(1);
    expect(vercelOnly.stderr).toContain("Canonical site URL");

    expect(run({ SITE_URL: "https://immojudis.com" }).status).toBe(0);
  });
});
