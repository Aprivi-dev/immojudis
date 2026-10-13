import { afterEach, describe, expect, it, vi } from "vitest";
import { isNonProductionVercelDeployment, resolveSiteOrigin } from "@/lib/site-url";

describe("canonical site URL", () => {
  it("uses one normalized origin with explicit precedence", () => {
    expect(
      resolveSiteOrigin({
        SITE_URL: "https://immojudis.fr/",
        NEXT_PUBLIC_APP_URL: "https://legacy.example",
      }),
    ).toBe("https://immojudis.fr");
    expect(resolveSiteOrigin({ VERCEL_URL: "preview.vercel.app" })).toBe(
      "https://preview.vercel.app",
    );
  });

  it("uses VERCEL_URL only outside the production deployment", () => {
    for (const VERCEL_ENV of ["preview", "development", undefined]) {
      expect(resolveSiteOrigin({ VERCEL_ENV, VERCEL_URL: "preview.vercel.app" })).toBe(
        "https://preview.vercel.app",
      );
    }
    // In production the deployment address is never the canonical origin.
    expect(resolveSiteOrigin({ VERCEL_ENV: "production", VERCEL_URL: "x.vercel.app" })).toBeNull();
    expect(
      resolveSiteOrigin(
        { VERCEL_ENV: "production", VERCEL_URL: "x.vercel.app" },
        "http://localhost:3000",
      ),
    ).toBe("http://localhost:3000");
    // An explicit origin still wins, in every environment.
    expect(
      resolveSiteOrigin({
        VERCEL_ENV: "production",
        SITE_URL: "https://immojudis.com",
        VERCEL_URL: "x.vercel.app",
      }),
    ).toBe("https://immojudis.com");
  });

  it("rejects unsupported protocols and embedded credentials", () => {
    expect(() => resolveSiteOrigin({ SITE_URL: "javascript:alert(1)" })).toThrow(
      "URL canonique invalide",
    );
    expect(() => resolveSiteOrigin({ SITE_URL: "https://user:secret@example.test" })).toThrow(
      "URL canonique non autorisée",
    );
    expect(() => resolveSiteOrigin({ SITE_URL: "https://example.test/app" })).toThrow(
      "sans chemin",
    );
  });

  it("returns the explicit local fallback when no URL is configured", () => {
    expect(resolveSiteOrigin({}, "http://localhost:3000/")).toBe("http://localhost:3000");
  });
});

describe("non-production Vercel deployment", () => {
  it("is true only when VERCEL_ENV is set to something else than production", () => {
    expect(isNonProductionVercelDeployment({ VERCEL_ENV: "preview" })).toBe(true);
    expect(isNonProductionVercelDeployment({ VERCEL_ENV: "development" })).toBe(true);
    expect(isNonProductionVercelDeployment({ VERCEL_ENV: "production" })).toBe(false);
    expect(isNonProductionVercelDeployment({ VERCEL_ENV: " " })).toBe(false);
    expect(isNonProductionVercelDeployment({})).toBe(false);
  });
});

describe("X-Robots-Tag header of next.config.ts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function robotsHeader(vercelEnv: string | undefined) {
    vi.resetModules();
    if (vercelEnv === undefined) vi.stubEnv("VERCEL_ENV", "");
    else vi.stubEnv("VERCEL_ENV", vercelEnv);
    const { default: config } = await import("../../next.config");
    const [rule] = await config.headers!();
    return rule.headers.find((header) => header.key === "X-Robots-Tag");
  }

  it("noindexes preview deployments", async () => {
    expect(await robotsHeader("preview")).toEqual({
      key: "X-Robots-Tag",
      value: "noindex, nofollow",
    });
  });

  it("leaves production and local runs indexable", async () => {
    expect(await robotsHeader("production")).toBeUndefined();
    expect(await robotsHeader(undefined)).toBeUndefined();
  });
});
