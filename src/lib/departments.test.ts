import { describe, expect, it } from "vitest";
import { FEES_SIMULATOR_DEPARTMENTS } from "@/components/fees-simulator/departments";
import { DEPARTMENTS } from "@/lib/department-pages";
import { resolveFrenchGeoSearch } from "@/lib/search/french-geo-search";
import { FRENCH_DEPARTMENTS } from "./departments";

describe("référentiel des départements", () => {
  it("liste 101 départements aux codes uniques", () => {
    expect(FRENCH_DEPARTMENTS).toHaveLength(101);
    expect(new Set(FRENCH_DEPARTMENTS.map(({ code }) => code)).size).toBe(101);
    expect(FRENCH_DEPARTMENTS[0]).toEqual({ code: "01", name: "Ain" });
    expect(FRENCH_DEPARTMENTS.at(-1)).toEqual({ code: "976", name: "Mayotte" });
  });

  it("est la seule source du simulateur, des pages par département et de la recherche", () => {
    expect(FEES_SIMULATOR_DEPARTMENTS).toBe(FRENCH_DEPARTMENTS);
    expect(DEPARTMENTS.map(({ code, name }) => ({ code, name }))).toEqual(FRENCH_DEPARTMENTS);
    for (const { code, name } of FRENCH_DEPARTMENTS) {
      expect(resolveFrenchGeoSearch(code)).toEqual({ kind: "department", departments: [code] });
      // Outre-mer : le département porte le nom de sa région, résolue comme région de même périmètre.
      const byName = resolveFrenchGeoSearch(name);
      expect(byName.kind === "department" || byName.kind === "region").toBe(true);
      expect("departments" in byName ? byName.departments : []).toEqual([code]);
    }
  });
});
