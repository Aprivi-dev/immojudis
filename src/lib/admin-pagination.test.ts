import { describe, expect, it } from "vitest";
import { adminCatalogueReadinessQuerySchema } from "@/lib/admin-catalogue-readiness";
import { adminPageQuerySchema } from "@/lib/admin-page-query";
import { adminInformationAgentReviewQuerySchema } from "@/lib/admin-information-agent";
import {
  ADMIN_PAGE_SIZE,
  adminClampOffset,
  adminNextOffset,
  adminPageMeta,
  adminPageRange,
  adminPreviousOffset,
} from "@/lib/admin-pagination";

describe("admin pagination helpers", () => {
  it("uses 50 rows per page", () => {
    expect(ADMIN_PAGE_SIZE).toBe(50);
  });

  it("reports whether another page exists", () => {
    expect(adminPageMeta({ offset: 0, limit: 50, total: 50 }).hasMore).toBe(false);
    expect(adminPageMeta({ offset: 0, limit: 50, total: 51 }).hasMore).toBe(true);
    expect(adminPageMeta({ offset: 50, limit: 50, total: 100 }).hasMore).toBe(false);
  });

  it("formats the visible range", () => {
    expect(adminPageRange({ offset: 50, shown: 50, total: 230 })).toBe("51–100 sur 230");
    expect(adminPageRange({ offset: 0, shown: 0, total: 0 })).toBe("0 sur 0");
  });

  it("never moves outside the available pages", () => {
    expect(adminPreviousOffset(0, 50)).toBe(0);
    expect(adminPreviousOffset(100, 50)).toBe(50);
    expect(adminNextOffset(0, 50, 50)).toBe(0);
    expect(adminNextOffset(0, 50, 51)).toBe(50);
  });

  it("steps back to the last non-empty page when rows disappear", () => {
    expect(adminClampOffset(50, 50, 50)).toBe(0);
    expect(adminClampOffset(100, 50, 101)).toBe(100);
    expect(adminClampOffset(150, 50, 120)).toBe(100);
    expect(adminClampOffset(50, 50, 0)).toBe(50);
    expect(adminClampOffset(0, 50, 10)).toBe(0);
  });
});

describe.each([
  ["adminPageQuerySchema", adminPageQuerySchema],
  ["catalogue readiness", adminCatalogueReadinessQuerySchema],
  ["information agent review", adminInformationAgentReviewQuerySchema],
])("%s query validation", (_name, schema) => {
  it("defaults to the first 50 rows", () => {
    expect(schema.parse({})).toEqual({ offset: 0, limit: 50 });
  });

  it("coerces query-string numbers", () => {
    expect(schema.parse({ offset: "100", limit: "25" })).toEqual({ offset: 100, limit: 25 });
  });

  it.each([
    { limit: "0" },
    { limit: "101" },
    { limit: "2.5" },
    { limit: "abc" },
    { offset: "-1" },
    { offset: "100001" },
    { offset: "1.5" },
  ])("rejects %j", (input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });
});
