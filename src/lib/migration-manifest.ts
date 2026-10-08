import { readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATION_VERSION_PATTERN = /^(\d{14})_.+\.sql$/;

/**
 * Fallback used when the deployment artifact does not include supabase/migrations.
 * Keep this value aligned with the checked-in manifest below; local runtimes resolve
 * the actual latest file so a new migration cannot silently leave readiness stale.
 */
export const MIGRATION_MANIFEST = {
  source: "supabase/migrations",
  fallbackLatestVersion: "20261006095220",
} as const;

export function resolveExpectedLatestMigrationVersion(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): string {
  const configured = env.IMMOJUDIS_EXPECTED_LATEST_MIGRATION_VERSION?.trim();
  if (configured && /^\d{14}$/.test(configured)) return configured;

  try {
    const versions = readdirSync(join(process.cwd(), "supabase", "migrations"))
      .map((file) => file.match(MIGRATION_VERSION_PATTERN)?.[1] ?? null)
      .filter((version): version is string => version !== null)
      .sort();
    return versions.at(-1) ?? MIGRATION_MANIFEST.fallbackLatestVersion;
  } catch {
    return MIGRATION_MANIFEST.fallbackLatestVersion;
  }
}
