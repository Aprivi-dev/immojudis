import { describe, expect, it } from "vitest";
import { saleDetailPath } from "./navigation";

describe("saleDetailPath", () => {
  const ID = "005a914d-563c-427b-88a4-740cbf851afb";

  it("adds no ?from= when the way back is the unfiltered catalogue", () => {
    expect(saleDetailPath(ID)).toBe(`/sales/${ID}`);
    expect(saleDetailPath(ID, "/sales")).toBe(`/sales/${ID}`);
    // An empty query string is the same page.
    expect(saleDetailPath(ID, "/sales?")).toBe(`/sales/${ID}`);
  });

  it("keeps the filters of the search the visitor comes from", () => {
    expect(saleDetailPath(ID, "/sales?city=Toulouse&page=2")).toBe(
      `/sales/${ID}?from=%2Fsales%3Fcity%3DToulouse%26page%3D2`,
    );
  });

  it("ignores a way back that is not the catalogue", () => {
    expect(saleDetailPath(ID, "/favoris")).toBe(`/sales/${ID}`);
    expect(saleDetailPath(ID, "https://evil.example/sales")).toBe(`/sales/${ID}`);
    expect(saleDetailPath(ID, "//evil.example/sales")).toBe(`/sales/${ID}`);
  });
});
