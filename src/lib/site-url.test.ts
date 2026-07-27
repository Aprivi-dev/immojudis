import { describe, expect, it } from "vitest";
import { resolveSiteOrigin } from "@/lib/site-url";

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
