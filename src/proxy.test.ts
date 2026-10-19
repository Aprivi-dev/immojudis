import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config, proxy } from "./proxy";

function run(headers: Record<string, string> = {}) {
  return proxy(new NextRequest("https://immojudis.com/sales", { headers }));
}

describe("proxy CSP", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("sends no strict policy by default: no violation to report, the historical CSP protects", () => {
    const response = run();

    expect(response.headers.get("content-security-policy-report-only")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("reporting-endpoints")).toBeNull();
    // No nonce is handed to Next.js either: nothing to stamp, nothing that forces dynamic rendering.
    expect(response.headers.get("x-middleware-override-headers") ?? "").not.toContain("x-nonce");
    expect(response.headers.get("x-middleware-override-headers") ?? "").not.toContain(
      "content-security-policy",
    );
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("does not send it either when CSP_REPORT_ONLY is explicitly true", () => {
    vi.stubEnv("CSP_REPORT_ONLY", "true");
    const response = run();
    expect(response.headers.get("content-security-policy-report-only")).toBeNull();
    expect(response.headers.get("reporting-endpoints")).toBeNull();
  });

  it("previews it in report-only mode with CSP_NONCE_DYNAMIC=true, never replacing the page's policy", () => {
    vi.stubEnv("CSP_NONCE_DYNAMIC", "true");
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
    expect(response.headers.get("reporting-endpoints")).toContain("/api/csp-report");
  });

  it("hands the same fresh nonce to Next.js through the forwarded request headers", () => {
    vi.stubEnv("CSP_NONCE_DYNAMIC", "true");
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

describe("proxy /sales ISR variant", () => {
  afterEach(() => vi.unstubAllEnvs());

  const request = (url: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
    proxy(new NextRequest(url, init));
  const rewrittenTo = (response: Response) => response.headers.get("x-middleware-rewrite");

  it("rewrites the bare address to the static variant, keeping the address of the visitor", () => {
    const response = request("https://immojudis.com/sales");
    expect(rewrittenTo(response)).toBe("https://immojudis.com/sales/defaut");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(response.headers.get("x-middleware-override-headers")).toContain("x-request-id");
  });

  it("rewrites HEAD too, and keeps the indexation header of the proxy", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("SEO_INDEXING_ENABLED", "");
    const response = request("https://immojudis.com/sales", { method: "HEAD" });
    expect(rewrittenTo(response)).toBe("https://immojudis.com/sales/defaut");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("leaves every filtered address, and every page but the 2nd and 3rd, to the page rendered on demand", () => {
    for (const search of [
      "?page=4",
      "?page=1",
      "?page=02",
      "?page=2&page=3",
      "?page=2&city=Pau",
      "?page=2&view=table",
      "?page=2&utm_source=x",
      "?city=Pau&sort=price_asc",
      "?view=table",
      "?utm_source=x",
    ]) {
      const response = request(`https://immojudis.com/sales${search}`);
      expect(rewrittenTo(response), search).toBeNull();
    }
  });

  it("rewrites ?page=2 and ?page=3 to their static variant, dropping the query from the target", () => {
    for (const page of [2, 3]) {
      const response = request(`https://immojudis.com/sales?page=${page}`);
      expect(rewrittenTo(response)).toBe(`https://immojudis.com/sales/defaut/${page}`);
      expect(response.headers.get("x-request-id")).toBeTruthy();
      // The address of the visitor keeps its indexable status (only the direct variant is noindex).
      vi.stubEnv("VERCEL_ENV", "production");
      vi.stubEnv("SEO_INDEXING_ENABLED", "true");
      expect(
        request(`https://immojudis.com/sales?page=${page}`).headers.get("x-robots-tag"),
      ).toBeNull();
    }
  });

  it("sets no cookie on the page shared between visitors", () => {
    // The shared cache may only hold what is the same for everyone: the response of the rewrite
    // carries no `Set-Cookie` (and the variants read no cookie, see their page tests).
    const response = request("https://immojudis.com/sales?page=2", {
      headers: { cookie: "sb-access-token=secret" },
    });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("does not rewrite page writes", () => {
    expect(
      rewrittenTo(request("https://immojudis.com/sales?page=2", { method: "POST" })),
    ).toBeNull();
  });

  it("serves the page variants asked for directly, never indexable", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("SEO_INDEXING_ENABLED", "true");
    const response = request("https://immojudis.com/sales/defaut/2");
    expect(rewrittenTo(response)).toBeNull();
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("does not touch the other pages or the sale pages", () => {
    for (const path of ["/", "/sales/2f6c1c3e", "/sales/sitemap/0.xml", "/api/sales/ai-review"]) {
      expect(rewrittenTo(request(`https://immojudis.com${path}`)), path).toBeNull();
    }
  });

  it("does not rewrite writes", () => {
    expect(rewrittenTo(request("https://immojudis.com/sales", { method: "POST" }))).toBeNull();
  });

  it("serves the variant asked for directly, never indexable (even once the site is open)", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("SEO_INDEXING_ENABLED", "true");
    const response = request("https://immojudis.com/sales/defaut");
    expect(response.status).toBe(200);
    expect(rewrittenTo(response)).toBeNull();
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    // The public address of the same page stays indexable.
    expect(request("https://immojudis.com/sales").headers.get("x-robots-tag")).toBeNull();
  });

  describe("with the strict nonce CSP served (it needs a render at request time)", () => {
    it.each([
      ["enforced", { CSP_REPORT_ONLY: "false" }],
      ["previewed", { CSP_NONCE_DYNAMIC: "true" }],
    ])("does not rewrite the bare address when it is %s", (_label, env) => {
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      const response = request("https://immojudis.com/sales");
      expect(rewrittenTo(response)).toBeNull();
      expect(response.headers.get("x-middleware-request-x-nonce")).toBeTruthy();
    });

    it.each([
      ["enforced", { CSP_REPORT_ONLY: "false" }],
      ["previewed", { CSP_NONCE_DYNAMIC: "true" }],
    ])("does not rewrite ?page=2 either when it is %s: a nonce needs a render", (_label, env) => {
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      const response = request("https://immojudis.com/sales?page=2");
      expect(rewrittenTo(response)).toBeNull();
      expect(response.headers.get("x-middleware-request-x-nonce")).toBeTruthy();
    });

    it("sends a page variant asked for directly back to its public address", () => {
      vi.stubEnv("CSP_REPORT_ONLY", "false");
      const response = request("https://immojudis.com/sales/defaut/3");
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe("https://immojudis.com/sales?page=3");
    });

    it("sends the variant asked for directly back to /sales", () => {
      vi.stubEnv("CSP_REPORT_ONLY", "false");
      const response = request("https://immojudis.com/sales/defaut");
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe("https://immojudis.com/sales");
    });
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
