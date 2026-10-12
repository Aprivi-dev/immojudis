import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "./proxy";

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
