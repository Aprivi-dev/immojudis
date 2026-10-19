import { describe, expect, it } from "vitest";
import { DEPARTMENTS } from "@/lib/department-pages";
import { DEPARTMENT_NEIGHBORS, neighboringDepartmentCodes } from "./department-neighbors";

describe("DEPARTMENT_NEIGHBORS", () => {
  const known = new Set(DEPARTMENTS.map((department) => department.code));
  const overseas = DEPARTMENTS.filter((department) => department.code.length === 3);

  it("ne cite que des départements qui ont une page", () => {
    for (const [code, neighbors] of Object.entries(DEPARTMENT_NEIGHBORS)) {
      expect(known.has(code), code).toBe(true);
      for (const neighbor of neighbors)
        expect(known.has(neighbor), `${code} → ${neighbor}`).toBe(true);
    }
  });

  it("couvre tous les départements de métropole", () => {
    const metropolitan = DEPARTMENTS.filter((department) => department.code.length === 2);
    expect(metropolitan.length).toBeGreaterThan(90);
    for (const department of metropolitan) {
      expect(DEPARTMENT_NEIGHBORS[department.code], department.code).toBeDefined();
    }
    for (const department of overseas) {
      expect(DEPARTMENT_NEIGHBORS[department.code]).toBeUndefined();
    }
  });

  it("est symétrique : si A touche B, B touche A", () => {
    for (const [code, neighbors] of Object.entries(DEPARTMENT_NEIGHBORS)) {
      for (const neighbor of neighbors) {
        expect(DEPARTMENT_NEIGHBORS[neighbor], `${neighbor} touche ${code}`).toContain(code);
      }
    }
  });

  it("n'a ni doublon ni département voisin de lui-même", () => {
    for (const [code, neighbors] of Object.entries(DEPARTMENT_NEIGHBORS)) {
      expect(new Set(neighbors).size, code).toBe(neighbors.length);
      expect(neighbors, code).not.toContain(code);
      expect(neighbors.length, code).toBeGreaterThan(0);
    }
  });

  it("donne les voisins connus de quelques départements", () => {
    expect([...neighboringDepartmentCodes("75")].sort()).toEqual(["92", "93", "94"]);
    expect(neighboringDepartmentCodes("33")).toEqual(["17", "24", "40", "47"]);
    expect(neighboringDepartmentCodes("2a")).toEqual(["2B"]);
    expect(neighboringDepartmentCodes("974")).toEqual([]);
    expect(neighboringDepartmentCodes("zz")).toEqual([]);
  });
});
