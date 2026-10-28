import { describe, expect, it } from "vitest";
import { isMissingDatabaseObject, isMissingRpcError } from "./postgrest-errors";

describe("isMissingDatabaseObject", () => {
  it.each(["PGRST202", "PGRST205", "42883", "42P01"])(
    "reconnaît %s (migration en retard)",
    (code) => {
      expect(isMissingDatabaseObject({ code, message: "absent" })).toBe(true);
    },
  );

  it.each(["57014", "23502", "42501", "PGRST116", "08006"])(
    "ne prend pas %s pour un objet absent : une panne n'est pas une migration en retard",
    (code) => {
      expect(isMissingDatabaseObject({ code })).toBe(false);
    },
  );

  it("tolère une erreur absente ou sans code", () => {
    for (const value of [null, undefined, "42P01", 42, {}, { code: 42883 }]) {
      expect(isMissingDatabaseObject(value)).toBe(false);
    }
  });
});

describe("isMissingRpcError", () => {
  it("ne vise que les fonctions", () => {
    expect(isMissingRpcError({ code: "PGRST202" })).toBe(true);
    expect(isMissingRpcError({ code: "42883" })).toBe(true);
    expect(isMissingRpcError({ code: "42P01" })).toBe(false);
  });
});
