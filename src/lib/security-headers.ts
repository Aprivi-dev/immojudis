type SecurityHeaderOptions = {
  enforceCsp: boolean;
  isProduction: boolean;
  osmTileUrl?: string;
  supabaseUrl?: string;
};

export type SecurityHeader = { key: string; value: string };

export function buildSecurityHeaders(options: SecurityHeaderOptions): SecurityHeader[] {
  const connectSources = new Set([
    "'self'",
    "https://api-adresse.data.gouv.fr",
    "https://api.mapbox.com",
    "https://events.mapbox.com",
    "https://*.tiles.mapbox.com",
    "https://*.supabase.co",
    "wss://*.supabase.co",
  ]);
  for (const candidate of [options.supabaseUrl, options.osmTileUrl]) {
    const origin = safeOrigin(candidate);
    if (origin) connectSources.add(origin);
  }

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

  const headers: SecurityHeader[] = [
    {
      key: options.enforceCsp ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only",
      value: directives.join("; "),
    },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
    { key: "X-DNS-Prefetch-Control", value: "off" },
    {
      key: "Permissions-Policy",
      value: 'camera=(), microphone=(), geolocation=(self), payment=(self "https://js.stripe.com")',
    },
  ];

  if (options.isProduction) {
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains; preload",
    });
  }

  return headers;
}

function safeOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.replaceAll(/[{}]/g, "0"));
    return url.protocol === "https:" || url.protocol === "wss:" ? url.origin : null;
  } catch {
    return null;
  }
}
