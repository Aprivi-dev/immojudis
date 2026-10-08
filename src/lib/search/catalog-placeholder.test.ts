import { describe, expect, it } from "vitest";
import { catalogPlaceholder } from "./catalog-placeholder";

describe("catalogue data during refresh", () => {
  const rows = [{ id: "sale" }];
  it("retains a previous search only within the same resolved access scope", () => {
    expect(
      catalogPlaceholder(rows, ["sales-search", "old-query", "a:discovery"], "a:discovery"),
    ).toBe(rows);
  });
  it.each(["b:discovery", "a:analysis", "anonymous:preview", null])(
    "clears rows when the access scope changes to %s",
    (scope) => {
      expect(
        catalogPlaceholder(rows, ["sales-search", "old-query", "a:discovery"], scope),
      ).toBeUndefined();
    },
  );
  it("does not reuse an earlier cache key without an access scope", () => {
    expect(
      catalogPlaceholder(rows, ["sales-search", "old-query", false], "a:discovery"),
    ).toBeUndefined();
  });
});
