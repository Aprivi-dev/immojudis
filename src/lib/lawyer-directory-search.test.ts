import { describe, expect, it } from "vitest";
import { validateDirectorySearch } from "./lawyer-directory-search";

describe("lawyer directory filters", () => {
  it("keeps the known filters, trimmed", () => {
    expect(
      validateDirectorySearch({ bar: " Bordeaux ", city: "Pau", department: "64", saleId: "abc" }),
    ).toEqual({ bar: "Bordeaux", city: "Pau", department: "64", saleId: "abc" });
  });

  it("ignores empty, repeated or non-text values", () => {
    expect(validateDirectorySearch({ bar: "  ", city: ["a", "b"], department: 64 })).toEqual({
      bar: undefined,
      city: undefined,
      department: undefined,
      saleId: undefined,
    });
  });
});
