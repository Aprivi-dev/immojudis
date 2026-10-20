import { describe, expect, it } from "vitest";
import {
  emptyWorksBreakdownItem,
  MAX_WORKS_BREAKDOWN_ITEMS,
  parseWorksBreakdown,
  parseWorksNumber,
  summarizeWorksBreakdown,
  WORKS_BREAKDOWN_KINDS,
  worksBreakdownKindLabel,
  worksBreakdownLineTotal,
  type WorksBreakdownItem,
} from "./works-breakdown";

function item(overrides: Partial<WorksBreakdownItem> = {}): WorksBreakdownItem {
  return { ...emptyWorksBreakdownItem("a"), ...overrides };
}

describe("works breakdown", () => {
  it("lists the twelve kinds of work, and nothing priced", () => {
    expect(WORKS_BREAKDOWN_KINDS.map((kind) => kind.label)).toEqual([
      "Toiture",
      "Façade",
      "Électricité",
      "Plomberie",
      "Chauffage",
      "Menuiseries",
      "Isolation",
      "Cuisine",
      "Salle de bains",
      "Sols",
      "Peinture",
      "Autre",
    ]);
    // The kinds carry a key and a label only: no price, no default amount.
    for (const kind of WORKS_BREAKDOWN_KINDS) {
      expect(Object.keys(kind).sort()).toEqual(["key", "label"]);
    }
    expect(worksBreakdownKindLabel("salle_de_bains")).toBe("Salle de bains");
    expect(worksBreakdownKindLabel("")).toBe("Poste à choisir");
  });

  it("starts empty: no quantity, no unit and no cost proposed", () => {
    expect(emptyWorksBreakdownItem("x")).toEqual({
      id: "x",
      kind: "",
      label: "",
      quantity: "",
      unit: "",
      unitCost: "",
    });
    expect(summarizeWorksBreakdown([emptyWorksBreakdownItem("x")])).toEqual({
      total: 0,
      complete: 0,
      incomplete: 1,
    });
  });
});

describe("parseWorksNumber", () => {
  it("reads French and English decimals and refuses anything else", () => {
    expect(parseWorksNumber("12,5")).toBe(12.5);
    expect(parseWorksNumber("1 200")).toBe(1200);
    expect(parseWorksNumber("1 200,50")).toBe(1200.5);
    expect(parseWorksNumber("0")).toBe(0);
    for (const bad of ["", "  ", "-3", "abc", "1e", "Infinity"]) {
      expect(parseWorksNumber(bad), bad).toBeNull();
    }
  });
});

describe("worksBreakdownLineTotal", () => {
  it("multiplies the quantity by the unit cost, both typed by the user", () => {
    expect(
      worksBreakdownLineTotal(item({ kind: "peinture", quantity: "45,5", unitCost: "20" })),
    ).toBe(910);
    expect(worksBreakdownLineTotal(item({ kind: "toiture", quantity: "1", unitCost: "0" }))).toBe(
      0,
    );
  });

  it("stays incomplete without a chosen kind, a positive quantity or a cost", () => {
    expect(worksBreakdownLineTotal(item({ quantity: "1", unitCost: "100" }))).toBeNull();
    expect(
      worksBreakdownLineTotal(item({ kind: "sols", quantity: "0", unitCost: "100" })),
    ).toBeNull();
    expect(
      worksBreakdownLineTotal(item({ kind: "sols", quantity: "", unitCost: "100" })),
    ).toBeNull();
    expect(worksBreakdownLineTotal(item({ kind: "sols", quantity: "2", unitCost: "" }))).toBeNull();
    expect(
      worksBreakdownLineTotal(item({ kind: "sols", quantity: "2", unitCost: "-5" })),
    ).toBeNull();
  });

  it("refuses absurd values instead of feeding them to the ceiling", () => {
    expect(
      worksBreakdownLineTotal(item({ kind: "sols", quantity: "2000000", unitCost: "10" })),
    ).toBeNull();
    expect(
      worksBreakdownLineTotal(item({ kind: "sols", quantity: "1", unitCost: "99999999" })),
    ).toBeNull();
  });
});

describe("summarizeWorksBreakdown", () => {
  it("adds the complete lines and counts the others apart", () => {
    const summary = summarizeWorksBreakdown([
      item({ id: "1", kind: "toiture", quantity: "1", unitCost: "8000" }),
      item({ id: "2", kind: "peinture", quantity: "45,5", unitCost: "20,33" }),
      item({ id: "3", kind: "autre", quantity: "3" }),
    ]);

    expect(summary).toEqual({ total: 8925, complete: 2, incomplete: 1 });
  });
});

describe("parseWorksBreakdown", () => {
  it("keeps valid stored lines and drops everything else", () => {
    const parsed = parseWorksBreakdown([
      { id: "a", kind: "toiture", label: "", quantity: "1", unit: "forfait", unitCost: "5000" },
      { id: "b", kind: "pas-un-poste", quantity: 3, unitCost: { x: 1 } },
      null,
      "texte",
    ]);

    expect(parsed).toEqual([
      { id: "a", kind: "toiture", label: "", quantity: "1", unit: "forfait", unitCost: "5000" },
      { id: "b", kind: "", label: "", quantity: "", unit: "", unitCost: "" },
    ]);
  });

  it("is safe on untrusted input: wrong type, duplicate ids, long texts, too many lines", () => {
    expect(parseWorksBreakdown(undefined)).toEqual([]);
    expect(parseWorksBreakdown({ 0: {} })).toEqual([]);

    const duplicates = parseWorksBreakdown([{ id: "a" }, { id: "a" }, {}]);
    expect(new Set(duplicates.map((line) => line.id)).size).toBe(3);

    const [long] = parseWorksBreakdown([
      { id: "x".repeat(100), label: "y".repeat(500), unit: "z".repeat(50) },
    ]);
    expect(long.id).toHaveLength(40);
    expect(long.label).toHaveLength(60);
    expect(long.unit).toHaveLength(12);

    const many = parseWorksBreakdown(
      Array.from({ length: 100 }, (_, index) => ({ id: `l${index}` })),
    );
    expect(many).toHaveLength(MAX_WORKS_BREAKDOWN_ITEMS);
  });
});
