// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { safeSalesReturnTo } from "./navigation";
import { takeSaleReturnOrigin } from "./sale-return-origin";

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("takeSaleReturnOrigin", () => {
  it("reads the origin, removes it from the address bar and keeps the rest of the address", () => {
    window.history.replaceState(null, "", "/sales/abc?from=%2Fsales%3Fcity%3DPau&x=1#documents");
    expect(takeSaleReturnOrigin()).toBe("/sales?city=Pau");
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      "/sales/abc?x=1#documents",
    );
  });

  it("removes an unsafe origin from the address bar; the page rejects it on use", () => {
    window.history.replaceState(null, "", "/sales/abc?from=https%3A%2F%2Fevil.example");
    const origin = takeSaleReturnOrigin();
    expect(window.location.search).toBe("");
    expect(safeSalesReturnTo(origin)).toBeUndefined();
  });

  it("leaves an address without origin untouched", () => {
    window.history.replaceState(null, "", "/sales/abc?x=1");
    expect(takeSaleReturnOrigin()).toBeNull();
    expect(window.location.search).toBe("?x=1");
  });
});
