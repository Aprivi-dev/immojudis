import { describe, expect, it } from "vitest";
import {
  isSeoIndexingEnabled,
  isSiteIndexable,
  NOINDEX_ROBOTS_TAG,
  robotsTagHeaderValue,
} from "@/lib/seo-indexing";

describe("SEO indexing switch", () => {
  it("is closed unless SEO_INDEXING_ENABLED is exactly true", () => {
    expect(isSeoIndexingEnabled({})).toBe(false);
    expect(isSeoIndexingEnabled({ SEO_INDEXING_ENABLED: "" })).toBe(false);
    expect(isSeoIndexingEnabled({ SEO_INDEXING_ENABLED: "false" })).toBe(false);
    expect(isSeoIndexingEnabled({ SEO_INDEXING_ENABLED: "TRUE" })).toBe(false);
    expect(isSeoIndexingEnabled({ SEO_INDEXING_ENABLED: "1" })).toBe(false);
    expect(isSeoIndexingEnabled({ SEO_INDEXING_ENABLED: " true " })).toBe(true);
    expect(isSeoIndexingEnabled({ SEO_INDEXING_ENABLED: "true" })).toBe(true);
  });

  it("never opens a Vercel preview or development deployment", () => {
    const open = { SEO_INDEXING_ENABLED: "true" };
    expect(isSiteIndexable({ ...open, VERCEL_ENV: "production" })).toBe(true);
    expect(isSiteIndexable(open)).toBe(true);
    expect(isSiteIndexable({ ...open, VERCEL_ENV: "preview" })).toBe(false);
    expect(isSiteIndexable({ ...open, VERCEL_ENV: "development" })).toBe(false);
  });

  it("asks for noindex on every response while closed, and nothing once open", () => {
    expect(robotsTagHeaderValue({ VERCEL_ENV: "production" })).toBe(NOINDEX_ROBOTS_TAG);
    expect(NOINDEX_ROBOTS_TAG).toContain("noindex");
    expect(robotsTagHeaderValue({ VERCEL_ENV: "production", SEO_INDEXING_ENABLED: "true" })).toBe(
      null,
    );
  });
});
