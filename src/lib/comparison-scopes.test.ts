import { describe, expect, it, vi } from "vitest";
import { comparisonScopes, filterComparisonScope } from "@/lib/comparison-scopes";

const COMPLETE = {
  city: "Bordeaux",
  department: "33",
  tribunalCode: "tj-bordeaux",
  propertyType: "apartment",
};

const labels = (scopes: { label: string }[]) => scopes.map((scope) => scope.label);

describe("comparisonScopes", () => {
  it("va du plus étroit au plus large pour une vente complète, nommant les critères posés", () => {
    expect(comparisonScopes(COMPLETE)).toEqual([
      {
        label: "Même ville et même type de bien",
        city: "Bordeaux",
        department: "33",
        propertyType: "apartment",
      },
      {
        label: "Même tribunal et même type de bien",
        tribunalCode: "tj-bordeaux",
        propertyType: "apartment",
      },
      {
        label: "Même département et même type de bien",
        department: "33",
        propertyType: "apartment",
      },
      { label: "Même département", department: "33" },
      { label: "Même ville", city: "Bordeaux", department: "33" },
    ]);
  });

  it("ferme la cascade par le type de bien partout en France quand on le demande", () => {
    expect(comparisonScopes(COMPLETE, { nationwide: true }).at(-1)).toEqual({
      label: "Même type de bien",
      propertyType: "apartment",
    });
  });

  it("sans ville : tribunal puis département", () => {
    expect(labels(comparisonScopes({ ...COMPLETE, city: null }))).toEqual([
      "Même tribunal et même type de bien",
      "Même département et même type de bien",
      "Même département",
    ]);
  });

  it("sans tribunal : ville puis département", () => {
    expect(labels(comparisonScopes({ ...COMPLETE, tribunalCode: "" }))).toEqual([
      "Même ville et même type de bien",
      "Même département et même type de bien",
      "Même département",
      "Même ville",
    ]);
  });

  it("sans département : la ville seule, sans périmètre en double", () => {
    expect(comparisonScopes({ ...COMPLETE, department: null, tribunalCode: null })).toEqual([
      { label: "Même ville et même type de bien", city: "Bordeaux", propertyType: "apartment" },
      { label: "Même ville", city: "Bordeaux" },
    ]);
  });

  it("sans type de bien, aucun libellé ne promet le même type et aucun périmètre ne se répète", () => {
    expect(labels(comparisonScopes({ ...COMPLETE, propertyType: undefined }))).toEqual([
      "Même ville",
      "Même tribunal",
      "Même département",
    ]);
  });

  it("sans lieu connu, le type de bien est le seul périmètre ; sans rien, aucun", () => {
    expect(labels(comparisonScopes({ propertyType: "house" }))).toEqual(["Même type de bien"]);
    expect(comparisonScopes({})).toEqual([]);
  });
});

describe("filterComparisonScope", () => {
  function recorder() {
    const calls: string[] = [];
    const query = {
      eq: vi.fn((column: string, value: string) => (calls.push(`${column}=${value}`), query)),
      neq: vi.fn((column: string, value: string) => (calls.push(`${column}!=${value}`), query)),
    };
    return { query, calls };
  }

  it("pose chaque critère du périmètre et écarte la vente de référence", () => {
    const { query, calls } = recorder();
    const [scope] = comparisonScopes(COMPLETE);

    expect(filterComparisonScope(query, scope, "sale-1")).toBe(query);
    expect(calls).toEqual([
      "id!=sale-1",
      "city=Bordeaux",
      "department=33",
      "property_type=apartment",
    ]);
  });

  it("sans vente de référence (périmètre demandé), n'écarte rien", () => {
    const { query, calls } = recorder();

    filterComparisonScope(query, { label: "Même tribunal", tribunalCode: "tj-lyon" }, null);

    expect(calls).toEqual(["tribunal_code=tj-lyon"]);
  });
});
