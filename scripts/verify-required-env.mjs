import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const envFiles = [".env", ".env.local", ".env.production", ".env.production.local"];

for (const file of envFiles) {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] != null) continue;
    process.env[key] = unquoteEnvValue(rawValue.trim());
  }
}

const required = [
  {
    name: "VITE_GOOGLE_MAPS_API_KEY",
    label: "Google Maps JavaScript/Static Maps",
  },
];

const missing = required.filter(({ name }) => isMissingOrPlaceholder(process.env[name]));

if (missing.length > 0) {
  console.error("[env] Missing required public build variable(s):");
  for (const item of missing) {
    console.error(`  - ${item.name} (${item.label})`);
  }
  console.error("");
  console.error("Set them in Vercel Environment Variables and in local .env.local.");
  console.error("Do not commit API keys: browser Maps keys must live in env vars and be HTTP-referrer restricted.");
  process.exit(1);
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isMissingOrPlaceholder(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.startsWith("your-")) return true;
  return ["changeme", "change-me", "todo", "undefined", "null"].includes(normalized);
}
