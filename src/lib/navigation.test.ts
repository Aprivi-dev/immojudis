import { describe, expect, it } from "vitest";
import { loginPageMode, safeSalesReturnTo, saleDetailPath } from "./navigation";

describe("navigation helpers", () => {
  it("selects only supported login modes", () => {
    expect(loginPageMode("investor")).toBe("investor");
    expect(loginPageMode("professional")).toBe("professional");
    expect(loginPageMode("unknown")).toBe("login");
  });

  it("keeps only internal sales-list return URLs", () => {
    expect(safeSalesReturnTo("/sales?q=Bordeaux&sort=price_asc")).toBe(
      "/sales?q=Bordeaux&sort=price_asc",
    );
    expect(safeSalesReturnTo("/sales/123")).toBeUndefined();
    expect(safeSalesReturnTo("//example.com/sales")).toBeUndefined();
    expect(safeSalesReturnTo("https://example.com/sales")).toBeUndefined();
  });

  it("adds a safe return target to sale detail links", () => {
    expect(saleDetailPath("sale-1", "/sales?q=Bordeaux")).toBe(
      "/sales/sale-1?from=%2Fsales%3Fq%3DBordeaux",
    );
    expect(saleDetailPath("sale-1", "https://example.com/sales")).toBe("/sales/sale-1");
  });
});
