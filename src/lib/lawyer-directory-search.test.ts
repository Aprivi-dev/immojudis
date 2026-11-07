import { describe, expect, it } from "vitest";
import { hasDirectoryCriteria, validateDirectorySearch } from "./lawyer-directory-search";

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

  it("knows when the address names something to search (repasse n° 5)", () => {
    expect(hasDirectoryCriteria(validateDirectorySearch({}))).toBe(false);
    expect(hasDirectoryCriteria(validateDirectorySearch({ bar: " ", x: "1" }))).toBe(false);
    expect(hasDirectoryCriteria({ bar: "Aix-en-Provence" })).toBe(true);
    expect(hasDirectoryCriteria({ department: "13" })).toBe(true);
    expect(hasDirectoryCriteria({ city: "Pau" })).toBe(true);
    expect(hasDirectoryCriteria({ saleId: "abc" })).toBe(true);
  });
});
