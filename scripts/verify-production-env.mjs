#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";

const ENV_FILES = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
  ".env.vercel-production.local",
];
const initialEnv = new Set(
  Object.keys(process.env).filter((name) => !isMissing(process.env[name])),
);
const declaredProductionNames = new Set();

for (const file of ENV_FILES) {
  if (!existsSync(file)) continue;
  const isPulledProductionEnv = file === ".env.vercel-production.local";
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    if (isPulledProductionEnv) declaredProductionNames.add(match[1]);
    if (initialEnv.has(match[1])) continue;
    const value = unquote(match[2].trim());
    if (!isMissing(value) || isMissing(process.env[match[1]])) process.env[match[1]] = value;
  }
}

const requiredGroups = [
  {
    label: "Supabase public URL",
    names: ["NEXT_PUBLIC_SUPABASE_URL", "VITE_SUPABASE_URL"],
  },
  {
    label: "Supabase public key",
    names: [
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "VITE_SUPABASE_PUBLISHABLE_KEY",
    ],
  },
  {
    label: "Supabase server URL",
    names: ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "VITE_SUPABASE_URL"],
  },
  {
    label: "Supabase server/admin key",
    names: ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
  },
  {
    label: "Direct Postgres URL for migrations",
    names: ["SUPABASE_DB_URL", "POSTGRES_URL_NON_POOLING", "POSTGRES_URL"],
  },
  {
    label: "Vercel Cron secret",
    names: ["CRON_SECRET"],
  },
];

const optionalGroups = [
  {
    label: "Stripe checkout",
    names: ["STRIPE_SECRET_KEY", "STRIPE_ANALYSE_PRICE_ID"],
  },
  {
    label: "Stripe webhooks",
    names: ["STRIPE_WEBHOOK_SECRET"],
  },
  {
    label: "Investisseur plan checkout",
    names: ["STRIPE_INVESTISSEUR_PRICE_ID"],
  },
  {
    label: "Canonical app URL",
    names: ["NEXT_PUBLIC_APP_URL"],
  },
  {
    label: "Email alert delivery",
    names: ["RESEND_API_KEY", "ALERT_EMAIL_FROM"],
  },
];

const missing = requiredGroups.filter((group) => !firstPresent(group.names));
const warnings = optionalGroups.filter((group) => !firstPresent(group.names));

if (missing.length) {
  console.error("[env:prod] Missing required production environment groups:");
  for (const group of missing) {
    console.error(`  - ${group.label}: set one of ${group.names.join(", ")}`);
  }
}

if (warnings.length) {
  console.warn("[env:prod] Optional production groups not configured:");
  for (const group of warnings) {
    console.warn(`  - ${group.label}: ${group.names.join(", ")}`);
  }
}

if (missing.length) process.exit(1);

console.log("[env:prod] Required production environment groups are configured.");
const declaredOnly = requiredGroups
  .map((group) => group.names.find((name) => declaredProductionNames.has(name)))
  .filter((name) => name && isMissing(process.env[name]));
if (declaredOnly.length) {
  console.warn(
    `[env:prod] ${declaredOnly.length} required value(s) are present in Vercel but unreadable locally because they are sensitive.`,
  );
}

function firstPresent(names) {
  return names.find((name) => !isMissing(process.env[name]) || declaredProductionNames.has(name));
}

function unquote(value) {
  return value.replace(/^(['"])(.*)\1$/, "$2");
}

function isMissing(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return (
    !normalized ||
    normalized.startsWith("your-") ||
    ["changeme", "todo", "null", "undefined"].includes(normalized)
  );
}
