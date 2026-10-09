import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { resolveRequestId } from "@/lib/request-id";
import {
  buildCspResponseHeaders,
  buildStrictContentSecurityPolicy,
  generateCspNonce,
  resolveCspMode,
} from "@/lib/security-headers";

export function proxy(request: NextRequest) {
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);

  // Strict, nonce-based CSP (plan P4-04). Next.js reads the nonce from the request's CSP header
  // (the report-only variant is honoured too) and stamps it on the scripts of dynamic pages.
  const mode = resolveCspMode();
  const nonce = generateCspNonce();
  const cspHeaders = buildCspResponseHeaders({
    mode,
    policy: buildStrictContentSecurityPolicy({
      nonce,
      isProduction: process.env.NODE_ENV === "production",
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      extraFrameSources: process.env.CSP_FRAME_SRC_EXTRA,
    }),
  });
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(cspHeaders[0].key, cspHeaders[0].value);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("x-request-id", requestId);
  for (const header of cspHeaders) response.headers.set(header.key, header.value);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};
