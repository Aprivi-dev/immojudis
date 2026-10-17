import { describe, expect, it } from "vitest";
import {
  isSalesDefaultPath,
  isUnfilteredSalesRequest,
  mustSeedStaticCatalogue,
  publicPathname,
  SALES_DEFAULT_PATH,
  SALES_PATH,
} from "./sales-isr";

describe("isUnfilteredSalesRequest", () => {
  const request = (overrides: Partial<Parameters<typeof isUnfilteredSalesRequest>[0]> = {}) => ({
    method: "GET",
    pathname: "/sales",
    search: "",
    ...overrides,
  });

  it("accepts the bare address for GET and HEAD", () => {
    expect(isUnfilteredSalesRequest(request())).toBe(true);
    expect(isUnfilteredSalesRequest(request({ method: "HEAD" }))).toBe(true);
  });

  it("refuses any parameter: filters, pages, and tracking parameters stay dynamic", () => {
    for (const search of ["?page=2", "?city=Pau", "?view=table", "?utm_source=x", "?map=1", "?a"]) {
      expect(isUnfilteredSalesRequest(request({ search })), search).toBe(false);
    }
  });

  it("refuses other paths and methods", () => {
    expect(isUnfilteredSalesRequest(request({ pathname: "/sales/abc" }))).toBe(false);
    expect(isUnfilteredSalesRequest(request({ pathname: "/" }))).toBe(false);
    expect(isUnfilteredSalesRequest(request({ pathname: SALES_DEFAULT_PATH }))).toBe(false);
    expect(isUnfilteredSalesRequest(request({ method: "POST" }))).toBe(false);
  });
});

describe("internal variant", () => {
  it("recognises the variant and the files that depend on it, not a sale", () => {
    expect(isSalesDefaultPath(SALES_DEFAULT_PATH)).toBe(true);
    expect(isSalesDefaultPath(`${SALES_DEFAULT_PATH}/`)).toBe(true);
    expect(isSalesDefaultPath(`${SALES_DEFAULT_PATH}.segments/_tree.segment.rsc`)).toBe(true);
    expect(isSalesDefaultPath(`${SALES_DEFAULT_PATH}.rsc`)).toBe(true);
    expect(isSalesDefaultPath("/sales")).toBe(false);
    expect(isSalesDefaultPath("/sales/defaut-abc")).toBe(false);
    expect(isSalesDefaultPath("/sales/2f6c1c3e")).toBe(false);
  });

  it("presents itself as /sales and leaves every other path alone", () => {
    expect(publicPathname(SALES_DEFAULT_PATH)).toBe(SALES_PATH);
    expect(publicPathname("/sales")).toBe("/sales");
    expect(publicPathname("/sales/abc")).toBe("/sales/abc");
    expect(publicPathname("/")).toBe("/");
  });
});

describe("mustSeedStaticCatalogue", () => {
  it("refuses an empty regeneration in production, outside of `next build`", () => {
    expect(mustSeedStaticCatalogue({ NODE_ENV: "production" })).toBe(true);
    expect(mustSeedStaticCatalogue({ NODE_ENV: "production", NEXT_PHASE: "" })).toBe(true);
    expect(
      mustSeedStaticCatalogue({ NODE_ENV: "production", NEXT_PHASE: "phase-production-server" }),
    ).toBe(true);
  });

  it("lets `next build` render without a list (no database in CI)", () => {
    expect(
      mustSeedStaticCatalogue({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" }),
    ).toBe(false);
  });

  it("keeps the fallback in development and tests (no previous page to keep)", () => {
    expect(mustSeedStaticCatalogue({ NODE_ENV: "development" })).toBe(false);
    expect(mustSeedStaticCatalogue({ NODE_ENV: "test" })).toBe(false);
    expect(mustSeedStaticCatalogue({})).toBe(false);
  });
});
