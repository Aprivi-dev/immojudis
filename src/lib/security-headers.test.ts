import { describe, expect, it } from "vitest";
import {
  buildCspResponseHeaders,
  buildSecurityHeaders,
  buildStrictContentSecurityPolicy,
  cspRequiresDynamicRendering,
  generateCspNonce,
  resolveCspMode,
} from "./security-headers";

function headerMap(headers: { key: string; value: string }[]) {
  return Object.fromEntries(headers.map((header) => [header.key, header.value]));
}

describe("browser security headers", () => {
  it("ships framing, MIME, transport and the historical enforced CSP in production", () => {
    const values = headerMap(
      buildSecurityHeaders({ isProduction: true, supabaseUrl: "https://project.supabase.co" }),
    );

    expect(values["X-Content-Type-Options"]).toBe("nosniff");
    expect(values["X-Frame-Options"]).toBe("DENY");
    expect(values["Strict-Transport-Security"]).toContain("includeSubDomains");
    expect(values["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(values["Content-Security-Policy"]).toContain("object-src 'none'");
    expect(values["Content-Security-Policy"]).toContain("https://project.supabase.co");
    expect(values["Content-Security-Policy"]).toContain("https://data.geopf.fr");
    expect(values["Content-Security-Policy"]).not.toContain("'unsafe-eval'");
    expect(values["Content-Security-Policy-Report-Only"]).toBeUndefined();
  });

  it("allows eval only in development and omits HSTS there", () => {
    const values = headerMap(buildSecurityHeaders({ isProduction: false }));

    expect(values["Content-Security-Policy"]).toContain("'unsafe-eval'");
    expect(values["Strict-Transport-Security"]).toBeUndefined();
  });

  it("drops the historical CSP once the strict policy is enforced", () => {
    const values = headerMap(buildSecurityHeaders({ isProduction: true, includeLegacyCsp: false }));
    expect(values["Content-Security-Policy"]).toBeUndefined();
    expect(values["X-Frame-Options"]).toBe("DENY");
  });
});

describe("strict nonce-based CSP", () => {
  const policy = buildStrictContentSecurityPolicy({
    nonce: "bm9uY2U=",
    isProduction: true,
    supabaseUrl: "https://sgpakxtyvenlpeihuucm.supabase.co",
  });
  const directive = (name: string) =>
    policy
      .split("; ")
      .find((entry) => entry.startsWith(`${name} `))
      ?.split(" ")
      .slice(1) ?? [];

  it("replaces unsafe-inline scripts by a nonce and strict-dynamic", () => {
    const scripts = directive("script-src");
    expect(scripts).toContain("'nonce-bm9uY2U='");
    expect(scripts).toContain("'strict-dynamic'");
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
  });

  it("restricts connect-src to the exact Supabase project, https and wss", () => {
    const connect = directive("connect-src");
    expect(connect).toContain("https://sgpakxtyvenlpeihuucm.supabase.co");
    expect(connect).toContain("wss://sgpakxtyvenlpeihuucm.supabase.co");
    expect(connect.some((source) => source.includes("*.supabase.co"))).toBe(false);
  });

  it("restricts frame-src to the integrated services instead of https:", () => {
    const frames = directive("frame-src");
    expect(frames).not.toContain("https:");
    expect(frames).toEqual(
      expect.arrayContaining([
        "'self'",
        "https://js.stripe.com",
        "https://hooks.stripe.com",
        "https://www.google.com",
        "https://sgpakxtyvenlpeihuucm.supabase.co",
      ]),
    );
  });

  it("accepts extra document-viewer hosts only as https origins", () => {
    const extended = buildStrictContentSecurityPolicy({
      nonce: "x",
      isProduction: true,
      extraFrameSources:
        "https://documents.example.test/path, http://insecure.test javascript:alert(1)",
    });
    expect(extended).toContain("https://documents.example.test");
    expect(extended).not.toContain("insecure.test");
    expect(extended).not.toContain("javascript:");
  });

  it("reports violations and keeps the baseline hardening directives", () => {
    expect(policy).toContain("report-uri /api/csp-report");
    expect(policy).toContain("report-to csp-endpoint");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("upgrade-insecure-requests");
  });

  it("allows eval only outside production", () => {
    const dev = buildStrictContentSecurityPolicy({ nonce: "x", isProduction: false });
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).not.toContain("upgrade-insecure-requests");
  });

  it("generates an unpredictable nonce per call", () => {
    const first = generateCspNonce();
    expect(first).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(generateCspNonce()).not.toBe(first);
  });
});

describe("CSP delivery mode", () => {
  it("defaults to report-only and only enforces on an explicit CSP_REPORT_ONLY=false", () => {
    expect(resolveCspMode({})).toEqual({ reportOnly: true, enforced: false });
    expect(resolveCspMode({ CSP_REPORT_ONLY: "true" })).toEqual({
      reportOnly: true,
      enforced: false,
    });
    expect(resolveCspMode({ CSP_REPORT_ONLY: "" })).toEqual({ reportOnly: true, enforced: false });
    expect(resolveCspMode({ CSP_REPORT_ONLY: "0" })).toEqual({ reportOnly: true, enforced: false });
    expect(resolveCspMode({ CSP_REPORT_ONLY: " FALSE " })).toEqual({
      reportOnly: false,
      enforced: true,
    });
  });

  it("emits the report-only header by default and the enforcing header when enforced", () => {
    const reportOnly = headerMap(
      buildCspResponseHeaders({ policy: "default-src 'self'", mode: resolveCspMode({}) }),
    );
    expect(reportOnly["Content-Security-Policy-Report-Only"]).toBe("default-src 'self'");
    expect(reportOnly["Content-Security-Policy"]).toBeUndefined();
    expect(reportOnly["Reporting-Endpoints"]).toBe('csp-endpoint="/api/csp-report"');

    const enforced = headerMap(
      buildCspResponseHeaders({
        policy: "default-src 'self'",
        mode: resolveCspMode({ CSP_REPORT_ONLY: "false" }),
      }),
    );
    expect(enforced["Content-Security-Policy"]).toBe("default-src 'self'");
    expect(enforced["Content-Security-Policy-Report-Only"]).toBeUndefined();
  });

  it("renders dynamically only when enforcing or previewing nonce mode", () => {
    expect(cspRequiresDynamicRendering({})).toBe(false);
    expect(cspRequiresDynamicRendering({ CSP_NONCE_DYNAMIC: "true" })).toBe(true);
    expect(cspRequiresDynamicRendering({ CSP_REPORT_ONLY: "false" })).toBe(true);
  });
});
