import { existsSync, readFileSync } from "node:fs";

for (const file of [".env", ".env.local", ".env.production", ".env.production.local"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]] == null) process.env[match[1]] = unquote(match[2].trim());
  }
}

const missing = [
  [
    "VITE_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL",
    process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  ],
  [
    "VITE_SUPABASE_PUBLISHABLE_KEY or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  ],
]
  .filter(([, value]) => isMissing(value))
  .map(([label]) => label);

if (missing.length) {
  console.error(`[env] Missing required build variable(s): ${missing.join(", ")}`);
  process.exit(1);
}

const configuredSiteUrl =
  process.env.SITE_URL ||
  process.env.NEXT_PUBLIC_SITE_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  process.env.APP_URL ||
  process.env.VERCEL_URL;
if (configuredSiteUrl && !isValidHttpOrigin(configuredSiteUrl)) {
  console.error(`[env] Invalid canonical site URL: ${configuredSiteUrl}`);
  process.exit(1);
}

if (
  process.env.INFORMATION_AGENT_OUTBOUND_ENABLED === "true" &&
  Buffer.byteLength(process.env.INFORMATION_AGENT_PORTAL_SECRET?.trim() || "", "utf8") < 32
) {
  console.error(
    "[env] INFORMATION_AGENT_PORTAL_SECRET must contain at least 32 bytes when outbound information requests are enabled.",
  );
  process.exit(1);
}

const productionBuild = [process.env.VERCEL_ENV, process.env.VERCEL_TARGET_ENV].includes(
  "production",
);
if (
  productionBuild &&
  process.env.INFORMATION_AGENT_INBOUND_DOMAIN?.trim() &&
  !/^whsec_[A-Za-z0-9+/=_-]{16,}$/.test(process.env.RESEND_WEBHOOK_SECRET?.trim() || "")
) {
  console.error(
    "[env] RESEND_WEBHOOK_SECRET must be configured for the production information-agent inbound webhook.",
  );
  process.exit(1);
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
    ["changeme", "placeholder", "todo", "null", "undefined"].includes(normalized)
  );
}

function isValidHttpOrigin(value) {
  try {
    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
    const url = new URL(candidate);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
