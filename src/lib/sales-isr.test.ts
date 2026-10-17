import { describe, expect, it } from "vitest";
import {
  isSalesDefaultPath,
  isUnfilteredSalesRequest,
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
