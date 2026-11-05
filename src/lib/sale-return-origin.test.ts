// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { takeSaleReturnOrigin } from "./sale-return-origin";

afterEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("takeSaleReturnOrigin", () => {
  it("reads the origin, removes it from the address bar and keeps the other parameters", () => {
    window.history.replaceState(null, "", "/sales/abc?from=%2Fsales%3Fcity%3DPau&x=1#documents");
    expect(takeSaleReturnOrigin("abc")).toBe("/sales?city=Pau");
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      "/sales/abc?x=1#documents",
    );
  });

  it("keeps the origin for the tab, so a reload of the clean address still knows it", () => {
    window.history.replaceState(
      null,
      "",
      "/sales/abc?from=%2Ftribunaux%2Ftribunal-judiciaire-nice",
    );
    takeSaleReturnOrigin("abc");
    expect(window.location.search).toBe("");
    expect(takeSaleReturnOrigin("abc")).toBe("/tribunaux/tribunal-judiciaire-nice");
    // Another sale does not inherit it.
    window.history.replaceState(null, "", "/sales/other");
    expect(takeSaleReturnOrigin("other")).toBeNull();
  });

  it("drops an unsafe origin from the address bar without keeping it", () => {
    window.history.replaceState(null, "", "/sales/abc?from=https%3A%2F%2Fevil.example");
    expect(takeSaleReturnOrigin("abc")).toBeNull();
    expect(window.location.search).toBe("");
    expect(takeSaleReturnOrigin("abc")).toBeNull();
  });

  it("leaves an address without origin untouched", () => {
    window.history.replaceState(null, "", "/sales/abc?x=1");
    expect(takeSaleReturnOrigin("abc")).toBeNull();
    expect(window.location.search).toBe("?x=1");
  });
});
