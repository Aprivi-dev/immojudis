import type { NextConfig } from "next";
import { listingPhotoRemotePatterns } from "./src/lib/listing-photo-source.ts";
import { buildSecurityHeaders, resolveCspMode } from "./src/lib/security-headers.ts";

const propertyDemoEnabled = process.env.ENABLE_PROPERTY_DEMO === "true";
const securityHeaders = buildSecurityHeaders({
  // The nonce-based CSP is emitted per request by src/proxy.ts (report-only unless
  // CSP_REPORT_ONLY=false). Until it is enforced, the historical CSP keeps protecting pages.
  includeLegacyCsp: !resolveCspMode().enforced,
  isProduction: process.env.NODE_ENV === "production",
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL,
});

const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir: process.env.IMMOJUDIS_NEXT_DIST_DIR?.trim() || ".next",
  experimental: {
    // Synced workspaces can restore conflicting *.sst cache files ("… 2.sst"),
    // which Turbopack cannot parse. Enable persistence only on a reliable cache.
    turbopackFileSystemCacheForBuild: process.env.IMMOJUDIS_BUILD_CACHE === "true",
  },
  serverExternalPackages: ["pdfjs-dist"],
  outputFileTracingIncludes: {
    // Published PDFs are flattened server-side (pdf.js + native canvas) at acceptance time.
    "/api/admin/information-agent": [
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
      "./node_modules/@napi-rs/canvas/**/*",
      "./node_modules/@napi-rs/canvas-*/**/*",
    ],
    "/api/v1/sales/*/land-report": [
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
      "./node_modules/@napi-rs/canvas/**/*",
      "./node_modules/@napi-rs/canvas-*/**/*",
    ],
  },
  images: {
    remotePatterns: listingPhotoRemotePatterns,
    formats: ["image/avif", "image/webp"],
    qualities: [75, 85],
  },
  turbopack: {
    root: process.cwd(),
  },
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN:
      process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN ?? process.env.VITE_MAPBOX_ACCESS_TOKEN,
    NEXT_PUBLIC_MAPBOX_STYLE:
      process.env.NEXT_PUBLIC_MAPBOX_STYLE ??
      process.env.NEXT_PUBLIC_MAPBOX_STYLE_ID ??
      process.env.VITE_MAPBOX_STYLE ??
      process.env.VITE_MAPBOX_STYLE_ID,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
  async redirects() {
    // La page des offres a changé d'adresse : redirection permanente. Les liens, les signets
    // et les adresses de retour de paiement en /accompagnement continuent de fonctionner.
    const moved = [{ source: "/accompagnement", destination: "/offres", statusCode: 301 }];

    if (propertyDemoEnabled) {
      return moved;
    }

    return [
      ...moved,
      {
        source: "/properties",
        destination: "/annonce-exemple",
        permanent: false,
      },
      {
        source: "/properties/:path*",
        destination: "/annonce-exemple",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
