import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import {
  UNVERSIONED_ASSET_CACHE_CONTROL,
  buildUnversionedAssetCacheRules,
} from "./asset-cache-headers";

describe("cache of unversioned public assets", () => {
  it("revalidates in the background instead of on every visit, and is not immutable", () => {
    expect(UNVERSIONED_ASSET_CACHE_CONTROL).toBe(
      "public, max-age=86400, stale-while-revalidate=604800",
    );
    // Les fichiers n'ont pas d'empreinte de contenu : jamais `immutable`.
    expect(UNVERSIONED_ASSET_CACHE_CONTROL).not.toContain("immutable");
  });

  it("targets /media and /brand only", () => {
    expect(buildUnversionedAssetCacheRules().map((rule) => rule.source)).toEqual([
      "/media/:path*",
      "/brand/:path*",
    ]);
  });
});

describe("next.config headers()", () => {
  it("keeps the security headers on every path and adds the cache rule on assets", async () => {
    const rules = await nextConfig.headers!();
    const securityRule = rules.find((rule) => rule.source === "/(.*)");
    expect(securityRule).toBeDefined();
    const securityKeys = securityRule!.headers.map((header) => header.key);
    expect(securityKeys).toEqual(
      expect.arrayContaining(["X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy"]),
    );

    for (const source of ["/media/:path*", "/brand/:path*"]) {
      const rule = rules.find((candidate) => candidate.source === source);
      expect(rule, source).toBeDefined();
      expect(rule!.headers).toEqual([
        { key: "Cache-Control", value: UNVERSIONED_ASSET_CACHE_CONTROL },
      ]);
    }
  });

  it("never lets a cache rule override a security header", async () => {
    const rules = await nextConfig.headers!();
    const securityKeys = new Set(
      rules.find((rule) => rule.source === "/(.*)")!.headers.map((header) => header.key),
    );
    for (const rule of rules.filter((candidate) => candidate.source !== "/(.*)")) {
      for (const header of rule.headers) {
        expect(securityKeys.has(header.key), `${rule.source} ${header.key}`).toBe(false);
      }
    }
  });
});
