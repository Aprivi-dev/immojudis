import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { resolveRequestId } from "@/lib/request-id";
import { robotsTagHeaderValue } from "@/lib/seo-indexing";
import {
  buildCspResponseHeaders,
  buildStrictContentSecurityPolicy,
  generateCspNonce,
  resolveCspMode,
  strictCspEnabled,
} from "@/lib/security-headers";

/** Delivers the strict policy to the browser and its nonce to the Next.js renderer. */
function strictCspHeaders(requestHeaders: Headers) {
  const nonce = generateCspNonce();
  const cspHeaders = buildCspResponseHeaders({
    mode: resolveCspMode(),
    policy: buildStrictContentSecurityPolicy({
      nonce,
      isProduction: process.env.NODE_ENV === "production",
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      extraFrameSources: process.env.CSP_FRAME_SRC_EXTRA,
    }),
  });
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(cspHeaders[0].key, cspHeaders[0].value);
  return cspHeaders;
}

export function proxy(request: NextRequest) {
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);

  // Strict, nonce-based CSP (plan P4-04), delivered only when it is enforced (CSP_REPORT_ONLY=false)
  // or previewed (CSP_NONCE_DYNAMIC=true): `strictCspEnabled` explains why the report-only variant
  // is no longer sent by default (it flagged every script of every page, ~35 reports a visit). The
  // historical policy of next.config.ts keeps protecting the pages in the default mode. Next.js
  // reads the nonce from the request's CSP header (the report-only variant is honoured too) and
  // stamps it on the scripts of dynamic pages.
  const cspHeaders = strictCspEnabled() ? strictCspHeaders(requestHeaders) : [];

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("x-request-id", requestId);
  for (const header of cspHeaders) response.headers.set(header.key, header.value);
  // Indexation fermée (SEO_INDEXING_ENABLED absente ou différente de « true », aperçu Vercel) :
  // lue ici, à chaque requête, et non figée dans next.config.ts au build.
  const robotsTag = robotsTagHeaderValue();
  if (robotsTag) response.headers.set("X-Robots-Tag", robotsTag);
  return response;
}

// `/sitemap.xml` is no longer excluded: it gets the `X-Robots-Tag` like the secondary sitemaps
// (`/ressources/sitemap.xml`, `/sales/sitemap/N.xml`). `/_next/image` stays excluded on purpose
// (Next.js advises it: the proxy would run on every image variant for no use besides this header);
// the gap is documented in docs/vercel_setup.md.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|media/|brand/|favicon.ico|apple-touch-icon.png|icon-192.png|icon-512.png|manifest.webmanifest|robots.txt).*)",
  ],
};
