type SecurityHeaderOptions = {
  /** Ship the historical `'unsafe-inline'` CSP (enforced). Dropped once the strict CSP is enforced. */
  includeLegacyCsp?: boolean;
  isProduction: boolean;
  supabaseUrl?: string;
};

export type SecurityHeader = { key: string; value: string };

export const CSP_REPORT_PATH = "/api/csp-report";
export const CSP_REPORT_GROUP = "csp-endpoint";

/**
 * How the nonce-based CSP is delivered once it is delivered at all (see `strictCspEnabled`).
 * `CSP_REPORT_ONLY` defaults to true: the strict policy is only reported
 * (Content-Security-Policy-Report-Only) while the historical policy keeps protecting pages. Set
 * `CSP_REPORT_ONLY=false` to enforce it after a clean observation period.
 */
export type CspMode = { reportOnly: boolean; enforced: boolean };

export function resolveCspMode(env: Pick<NodeJS.ProcessEnv, string> = process.env): CspMode {
  const reportOnly = env.CSP_REPORT_ONLY?.trim().toLowerCase() !== "false";
  return { reportOnly, enforced: !reportOnly };
}

/**
 * Whether `src/proxy.ts` sends the strict, nonce-based policy at all: only when it is enforced
 * (`CSP_REPORT_ONLY=false`) or previewed (`CSP_NONCE_DYNAMIC=true`). In the default mode it sends
 * nothing: the historical policy alone protects the pages.
 *
 * Why not report-only by default any more: a nonce only reaches the scripts of pages rendered at
 * request time, and the pages that must stay static or cached (home, sale pages, the unfiltered
 * `/sales` served through ISR) carry none. Their ~35 scripts per page (26 `_next/static` chunks, 9
 * inline) were therefore all reported, by every visitor, and Safari and Firefox sent one
 * `POST /api/csp-report` per violation. Measured on Vercel (17/10/2026): even `/sales`, rendered
 * at request time, answered without a `nonce` attribute on any of its 34 `<script>` tags, whereas
 * `next start` stamps them (cause on Vercel not established: to investigate before enforcing). A
 * policy that cannot be satisfied tells nothing about the real policy, so it is no longer sent.
 *
 * Future path: nonces or hashes. Either render every page at request time (`CSP_NONCE_DYNAMIC=true`
 * previews the cost, then `CSP_REPORT_ONLY=false` enforces; no CDN cache, no ISR), or keep pages
 * static with Next.js experimental Subresource Integrity (`experimental.sri`, hash-based policy).
 * Either choice is its own decision; this switch is the only place to turn it on.
 */
export function strictCspEnabled(env: Pick<NodeJS.ProcessEnv, string> = process.env): boolean {
  return resolveCspMode(env).enforced || env.CSP_NONCE_DYNAMIC?.trim().toLowerCase() === "true";
}

/**
 * Nonces only reach scripts of dynamically rendered pages, so delivering the strict policy
 * (enforced, or previewed with `CSP_NONCE_DYNAMIC=true`) requires dynamic rendering. Same
 * condition as `strictCspEnabled`: without the policy there is no nonce to stamp.
 */
export const cspRequiresDynamicRendering = strictCspEnabled;

const BASE_CONNECT_SOURCES = [
  "'self'",
  "https://api-adresse.data.gouv.fr",
  "https://data.geopf.fr",
  "https://api.mapbox.com",
  "https://events.mapbox.com",
  "https://*.tiles.mapbox.com",
];

/** Historical policy: wildcard Supabase hosts and `'unsafe-inline'` scripts. */
function legacyContentSecurityPolicy(options: SecurityHeaderOptions): string {
  const connectSources = new Set([
    ...BASE_CONNECT_SOURCES,
    "https://*.supabase.co",
    "wss://*.supabase.co",
  ]);
  const origin = safeOrigin(options.supabaseUrl);
  if (origin) connectSources.add(origin);

  const scriptSources = ["'self'", "'unsafe-inline'", "https://js.stripe.com"];
  if (!options.isProduction) scriptSources.push("'unsafe-eval'");

  const directives = [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${Array.from(connectSources).join(" ")}`,
    "frame-src 'self' https://js.stripe.com https://hooks.stripe.com https:",
    "worker-src 'self' blob:",
    "media-src 'self' blob: https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (options.isProduction) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

export function buildSecurityHeaders(options: SecurityHeaderOptions): SecurityHeader[] {
  const headers: SecurityHeader[] = [];
  if (options.includeLegacyCsp !== false) {
    headers.push({
      key: "Content-Security-Policy",
      value: legacyContentSecurityPolicy(options),
    });
  }
  headers.push(
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
    { key: "X-DNS-Prefetch-Control", value: "off" },
    {
      key: "Permissions-Policy",
      value: 'camera=(), microphone=(), geolocation=(self), payment=(self "https://js.stripe.com")',
    },
  );

  if (options.isProduction) {
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains; preload",
    });
  }

  return headers;
}

type StrictCspOptions = {
  nonce: string;
  isProduction: boolean;
  supabaseUrl?: string;
  /** Extra https origins allowed to be framed (document viewer hosts), space or comma separated. */
  extraFrameSources?: string;
};

/**
 * Strict nonce-based policy (plan P4-04): no `'unsafe-inline'` scripts, `strict-dynamic`, the exact
 * Supabase project instead of `*.supabase.co`, and an explicit frame-src instead of `https:`.
 */
export function buildStrictContentSecurityPolicy(options: StrictCspOptions): string {
  const supabaseOrigin = safeOrigin(options.supabaseUrl);
  const supabaseRealtime = supabaseOrigin?.replace(/^https:/, "wss:");
  const connectSources = [
    ...BASE_CONNECT_SOURCES,
    ...(supabaseOrigin ? [supabaseOrigin] : []),
    ...(supabaseRealtime ? [supabaseRealtime] : []),
  ];

  const scriptSources = [
    "'self'",
    `'nonce-${options.nonce}'`,
    "'strict-dynamic'",
    // Ignored by browsers that support strict-dynamic; kept as the CSP2 fallback.
    "https://js.stripe.com",
  ];
  if (!options.isProduction) scriptSources.push("'unsafe-eval'");

  const frameSources = new Set([
    "'self'",
    "https://js.stripe.com",
    "https://hooks.stripe.com",
    // Google Maps Embed (Street View dialog).
    "https://www.google.com",
    ...(supabaseOrigin ? [supabaseOrigin] : []),
  ]);
  for (const candidate of (options.extraFrameSources ?? "").split(/[\s,]+/)) {
    const origin = safeOrigin(candidate);
    if (origin) frameSources.add(origin);
  }

  const directives = [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${connectSources.join(" ")}`,
    `frame-src ${Array.from(frameSources).join(" ")}`,
    "worker-src 'self' blob:",
    "media-src 'self' blob: https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    `report-uri ${CSP_REPORT_PATH}`,
    `report-to ${CSP_REPORT_GROUP}`,
  ];
  if (options.isProduction) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

/** Per-request nonce (base64 of a random UUID, as recommended by the Next.js CSP guide). */
export function generateCspNonce(): string {
  return btoa(crypto.randomUUID());
}

/** Headers the proxy adds to every document response. */
export function buildCspResponseHeaders(options: {
  policy: string;
  mode: CspMode;
}): SecurityHeader[] {
  return [
    {
      key: options.mode.reportOnly
        ? "Content-Security-Policy-Report-Only"
        : "Content-Security-Policy",
      value: options.policy,
    },
    { key: "Reporting-Endpoints", value: `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"` },
  ];
}

function safeOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.replaceAll(/[{}]/g, "0"));
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}
