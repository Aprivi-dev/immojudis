import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { resolveRequestId } from "@/lib/request-id";
import {
  isSalesDefaultPath,
  isUnfilteredSalesRequest,
  publicSalesAddress,
  SALES_DEFAULT_PATH,
  salesPageVariantFor,
} from "@/lib/sales-isr";
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

/**
 * `/sales` sans paramètre, `/sales?page=2` et `/sales?page=3` sont réécrits vers leur variante
 * statique (ISR, 5 minutes) : le visiteur et les robots gardent l'adresse demandée, le CDN sert la
 * page sans réveiller de fonction. Toute autre adresse du catalogue (filtre, autre page, paramètre
 * en plus) reste rendue à la demande. Voir `src/lib/sales-isr.ts`.
 *
 * Pas de réécriture quand la CSP à nonce est servie (`strictCspEnabled`) : un nonce ne se pose que
 * sur une page rendue à la demande, la variante statique n'en aurait pas. La variante demandée en
 * direct revient alors à l'adresse publique.
 */
function routeResponse(request: NextRequest, requestHeaders: Headers, strictCsp: boolean) {
  const { pathname, search } = request.nextUrl;
  if (strictCsp) {
    if (isSalesDefaultPath(pathname)) {
      return NextResponse.redirect(new URL(publicSalesAddress(pathname, search), request.url), 307);
    }
    return NextResponse.next({ request: { headers: requestHeaders } });
  }
  const salesRequest = { method: request.method, pathname, search };
  const variantPath = isUnfilteredSalesRequest(salesRequest)
    ? SALES_DEFAULT_PATH
    : salesPageVariantFor(salesRequest);
  if (variantPath) {
    const target = request.nextUrl.clone();
    target.pathname = variantPath;
    // La variante ne porte aucun paramètre : `?page=N` est déjà dans son chemin.
    target.search = "";
    return NextResponse.rewrite(target, { request: { headers: requestHeaders } });
  }
  return NextResponse.next({ request: { headers: requestHeaders } });
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
  const strictCsp = strictCspEnabled();
  const cspHeaders = strictCsp ? strictCspHeaders(requestHeaders) : [];

  const response = routeResponse(request, requestHeaders, strictCsp);
  response.headers.set("x-request-id", requestId);
  for (const header of cspHeaders) response.headers.set(header.key, header.value);
  // Indexation fermée (SEO_INDEXING_ENABLED absente ou différente de « true », aperçu Vercel) :
  // lue ici, à chaque requête, et non figée dans next.config.ts au build.
  const robotsTag = robotsTagHeaderValue();
  if (robotsTag) response.headers.set("X-Robots-Tag", robotsTag);
  // La variante interne, demandée en direct, ne s'indexe jamais, quel que soit l'état de l'indexation.
  if (isSalesDefaultPath(request.nextUrl.pathname)) {
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
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
