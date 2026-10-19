import { describe, expect, it } from "vitest";
import {
  isSalesDefaultPath,
  isUnfilteredSalesRequest,
  mustSeedStaticCatalogue,
  publicPathname,
  publicSalesAddress,
  SALES_DEFAULT_PATH,
  SALES_ISR_PAGES,
  SALES_PAGE_VARIANTS_ROUTE,
  SALES_PATH,
  salesPageVariantFor,
  salesPageVariantPath,
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

describe("page variants (?page=2 and ?page=3)", () => {
  const request = (overrides: Partial<Parameters<typeof salesPageVariantFor>[0]> = {}) => ({
    method: "GET",
    pathname: "/sales",
    search: "?page=2",
    ...overrides,
  });

  it("serves exactly the pages of SALES_ISR_PAGES, from the address with no other parameter", () => {
    expect(SALES_ISR_PAGES).toEqual([2, 3]);
    expect(salesPageVariantFor(request())).toBe("/sales/defaut/2");
    expect(salesPageVariantFor(request({ search: "?page=3" }))).toBe("/sales/defaut/3");
    expect(salesPageVariantFor(request({ method: "HEAD" }))).toBe("/sales/defaut/2");
    expect(salesPageVariantPath(3)).toBe("/sales/defaut/3");
  });

  it("refuses anything else: other pages, other spellings, extra parameters, writes, other paths", () => {
    for (const search of [
      "",
      "?page=1",
      "?page=4",
      "?page=02",
      "?page=2.0",
      "?page=2&view=table",
      "?view=table&page=2",
      "?page=2&page=3",
      "?city=Pau&page=2",
      "?page=2#top",
      "?page=",
      "?Page=2",
    ]) {
      expect(salesPageVariantFor(request({ search })), search).toBeNull();
    }
    expect(salesPageVariantFor(request({ method: "POST" }))).toBeNull();
    expect(salesPageVariantFor(request({ pathname: "/sales/abc" }))).toBeNull();
    expect(salesPageVariantFor(request({ pathname: "/ventes" }))).toBeNull();
  });

  it("presents the variants as /sales and finds the public address back", () => {
    expect(publicPathname("/sales/defaut/2")).toBe(SALES_PATH);
    expect(publicPathname("/sales/defaut/12")).toBe(SALES_PATH);
    expect(publicPathname("/sales/defaut/abc")).toBe("/sales/defaut/abc");
    expect(publicPathname("/sales/defaut/0")).toBe("/sales/defaut/0");
    expect(isSalesDefaultPath("/sales/defaut/2")).toBe(true);
    expect(publicSalesAddress("/sales/defaut", "")).toBe("/sales");
    expect(publicSalesAddress("/sales/defaut/3", "")).toBe("/sales?page=3");
    expect(publicSalesAddress("/sales/defaut.rsc", "?x=1")).toBe("/sales?x=1");
  });

  it("names the route pattern revalidated when a sale is withdrawn", () => {
    expect(SALES_PAGE_VARIANTS_ROUTE).toBe("/sales/defaut/[page]");
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
