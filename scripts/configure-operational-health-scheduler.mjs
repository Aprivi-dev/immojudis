#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
loadEnvironmentFiles(root);

const databaseUrl = firstFilledEnv(
  process.env.SUPABASE_DB_URL,
  process.env.POSTGRES_URL_NON_POOLING,
  process.env.POSTGRES_URL,
);
const cronSecret = firstFilledEnv(process.env.CRON_SECRET);
const originValue = firstFilledEnv(
  process.env.OPERATIONS_HEALTH_URL,
  process.env.NEXT_PUBLIC_APP_URL,
  process.env.SITE_URL,
);
const databaseConnectTimeoutSeconds = Math.min(
  900,
  Math.max(15, Number.parseInt(process.env.PGCONNECT_TIMEOUT || "60", 10) || 60),
);

if (!databaseUrl || !cronSecret || !originValue) {
  console.error(
    "[operational-health] SUPABASE_DB_URL, CRON_SECRET and OPERATIONS_HEALTH_URL (or NEXT_PUBLIC_APP_URL) are required.",
  );
  process.exit(1);
}

const origin = new URL(originValue);
if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/") {
  console.error(
    "[operational-health] The scheduler origin must be an HTTPS origin without credentials or path.",
  );
  process.exit(1);
}

const sql = postgres(withMaintenanceSessionSettings(databaseUrl), {
  max: 1,
  connect_timeout: databaseConnectTimeoutSeconds,
  ssl: process.env.POSTGRES_SSL === "disable" ? false : "require",
});

try {
  await upsertVaultSecret(
    sql,
    "immojudis_operational_health_url",
    origin.origin,
    "Canonical ImmoJudis origin used by the 15-minute operational health scheduler.",
  );
  await upsertVaultSecret(
    sql,
    "immojudis_operational_health_secret",
    cronSecret,
    "Bearer secret used only by the Supabase operational health scheduler.",
  );

  const [job] = await sql`
    select schedule, active
    from cron.job
    where jobname = 'immojudis-operational-health'
    limit 1
  `;
  if (!job || job.schedule !== "*/15 * * * *" || !job.active) {
    throw new Error("The 15-minute operational health job is missing or inactive.");
  }

  const [configured] = await sql`
    select count(*)::int as count
    from vault.decrypted_secrets
    where name in (
      'immojudis_operational_health_url',
      'immojudis_operational_health_secret'
    )
      and nullif(decrypted_secret, '') is not null
  `;
  if (configured?.count !== 2) throw new Error("Operational health Vault secrets were not stored.");

  console.log(
    JSON.stringify({
      ok: true,
      origin: origin.origin,
      schedule: job.schedule,
      vaultSecretsConfigured: configured.count,
    }),
  );
} finally {
  await sql.end({ timeout: 5 });
}

async function upsertVaultSecret(sql, name, value, description) {
  const [existing] = await sql`
    select id
    from vault.decrypted_secrets
    where name = ${name}
    order by updated_at desc
    limit 1
  `;
  if (existing?.id) {
    await sql`select vault.update_secret(${existing.id}, ${value}, ${name}, ${description})`;
    return;
  }
  await sql`select vault.create_secret(${value}, ${name}, ${description})`;
}

function loadEnvironmentFiles(directory) {
  const initialEnvironment = new Set(
    Object.keys(process.env).filter((name) => !isMissing(process.env[name])),
  );
  for (const file of [
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
    ".env.vercel-production.local",
  ]) {
    const path = join(directory, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
      if (!match || initialEnvironment.has(match[1])) continue;
      const value = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
      if (!isMissing(value)) process.env[match[1]] = value;
    }
  }
}

function firstFilledEnv(...values) {
  return values.find((value) => !isMissing(value))?.trim();
}

function withMaintenanceSessionSettings(databaseUrl) {
  const url = new URL(databaseUrl);
  if (url.hostname.endsWith(".pooler.supabase.com")) url.port = "5432";
  const existingOptions = url.searchParams.get("options")?.trim();
  if (!existingOptions?.includes("statement_timeout")) {
    url.searchParams.set(
      "options",
      [existingOptions, "-c statement_timeout=0 -c lock_timeout=0"].filter(Boolean).join(" "),
    );
  }
  return url.toString();
}

function isMissing(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return (
    !normalized || ["changeme", "placeholder", "todo", "null", "undefined"].includes(normalized)
  );
}
