import { describe, expect, it } from "vitest";
import { buildSecurityHeaders } from "./security-headers";

describe("browser security headers", () => {
  it("ships framing, MIME, transport and report-only CSP protections in production", () => {
    const headers = buildSecurityHeaders({
      enforceCsp: false,
      isProduction: true,
      supabaseUrl: "https://project.supabase.co",
    });
    const values = Object.fromEntries(headers.map((header) => [header.key, header.value]));

    expect(values["X-Content-Type-Options"]).toBe("nosniff");
    expect(values["X-Frame-Options"]).toBe("DENY");
    expect(values["Strict-Transport-Security"]).toContain("includeSubDomains");
    expect(values["Content-Security-Policy-Report-Only"]).toContain("frame-ancestors 'none'");
    expect(values["Content-Security-Policy-Report-Only"]).toContain("object-src 'none'");
    expect(values["Content-Security-Policy-Report-Only"]).toContain("https://project.supabase.co");
    expect(values["Content-Security-Policy-Report-Only"]).not.toContain("'unsafe-eval'");
  });

  it("supports explicit CSP enforcement and omits HSTS in local development", () => {
    const headers = buildSecurityHeaders({ enforceCsp: true, isProduction: false });
    const values = Object.fromEntries(headers.map((header) => [header.key, header.value]));

    expect(values["Content-Security-Policy"]).toContain("'unsafe-eval'");
    expect(values["Content-Security-Policy-Report-Only"]).toBeUndefined();
    expect(values["Strict-Transport-Security"]).toBeUndefined();
  });
});
