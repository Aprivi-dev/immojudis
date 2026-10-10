import { describe, expect, it } from "vitest";
import { departmentFromPostalCode, normalizeCommuneName } from "./commune-names";

describe("commune names", () => {
  // Same cases as services/data-pipeline/tests/test_reference_data.py: both
  // implementations must produce the stored `name_normalized` value.
  it.each([
    ["Saint-Étienne", "saint etienne"],
    ["ST ETIENNE", "saint etienne"],
    ["Ste-Foy-lès-Lyon", "sainte foy les lyon"],
    ["L'Haÿ-les-Roses", "l hay les roses"],
    ["Fontaine-St-Martin", "fontaine saint martin"],
    [null, ""],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeCommuneName(input)).toBe(expected);
  });

  it("derives the department of Corsican and overseas postal codes", () => {
    expect(departmentFromPostalCode("20000")).toBe("2A");
    expect(departmentFromPostalCode("20200")).toBe("2B");
    expect(departmentFromPostalCode("97400")).toBe("974");
    expect(departmentFromPostalCode("33000")).toBe("33");
    expect(departmentFromPostalCode("3300")).toBeNull();
  });
});
