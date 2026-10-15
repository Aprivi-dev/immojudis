import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config, proxy } from "./proxy";

function run(headers: Record<string, string> = {}) {
  return proxy(new NextRequest("https://immojudis.com/sales", { headers }));
}

describe("proxy CSP", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is report-only by default and never replaces the page's enforced policy", () => {
    const response = run();
    const report = response.headers.get("content-security-policy-report-only") ?? "";

    expect(report).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("reporting-endpoints")).toContain("/api/csp-report");
  });

  it("enforces the strict policy only when CSP_REPORT_ONLY=false", () => {
    vi.stubEnv("CSP_REPORT_ONLY", "false");
    const response = run();

    expect(response.headers.get("content-security-policy")).toContain("'strict-dynamic'");
    expect(response.headers.get("content-security-policy-report-only")).toBeNull();
  });

  it("hands the same fresh nonce to Next.js through the forwarded request headers", () => {
    const first = run();
    const second = run();
    const nonceOf = (response: Response) =>
      /'nonce-([^']+)'/.exec(
        response.headers.get("content-security-policy-report-only") ?? "",
      )?.[1];

    expect(nonceOf(first)).toBeTruthy();
    expect(nonceOf(first)).not.toBe(nonceOf(second));
    // NextResponse.next({ request }) exposes the overridden request headers to the renderer.
    expect(first.headers.get("x-middleware-override-headers")).toContain("x-nonce");
    expect(first.headers.get("x-middleware-request-x-nonce")).toBe(nonceOf(first));
    expect(first.headers.get("x-middleware-request-content-security-policy-report-only")).toContain(
      `'nonce-${nonceOf(first)}'`,
    );
  });

  it("keeps propagating the request id", () => {
    const response = run({ "x-request-id": "client-12345678" });
    expect(response.headers.get("x-request-id")).toBe("client-12345678");
  });
});

describe("proxy X-Robots-Tag", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("sends noindex on every response the proxy handles while SEO_INDEXING_ENABLED is not true (default)", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("SEO_INDEXING_ENABLED", "");
    expect(run().headers.get("x-robots-tag")).toBe("noindex, nofollow");
    vi.stubEnv("SEO_INDEXING_ENABLED", "false");
    expect(run().headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("sends nothing once the production site is open", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("SEO_INDEXING_ENABLED", "true");
    expect(run().headers.get("x-robots-tag")).toBeNull();
  });

  it("reads the switch at request time, not at import time", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("SEO_INDEXING_ENABLED", "true");
    expect(run().headers.get("x-robots-tag")).toBeNull();
    vi.stubEnv("SEO_INDEXING_ENABLED", "false");
    expect(run().headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("keeps noindex on a preview even with the switch open", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("SEO_INDEXING_ENABLED", "true");
    expect(run().headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});

describe("proxy matcher", () => {
  // Next.js reads each matcher as `/((?!...).*)`: the same pattern, anchored, as a plain RegExp.
  const matches = (path: string) =>
    config.matcher.some((pattern) => new RegExp(`^${pattern}$`).test(path));

  it("runs on pages, API routes and every sitemap, so they carry X-Robots-Tag when closed", () => {
    for (const path of [
      "/",
      "/sales",
      "/api/sales/ai-review",
      "/sitemap.xml",
      "/ressources/sitemap.xml",
      "/sales/sitemap/0.xml",
    ]) {
      expect(matches(path), path).toBe(true);
    }
  });

  it("skips static files, the image optimizer and robots.txt", () => {
    for (const path of ["/_next/static/chunk.js", "/_next/image", "/media/a.jpg", "/robots.txt"]) {
      expect(matches(path), path).toBe(false);
    }
  });
});
