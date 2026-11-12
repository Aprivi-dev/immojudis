import { describe, expect, it } from "vitest";
import { departmentCode } from "./department-code";
import { FRENCH_DEPARTMENTS } from "./departments";

describe("departmentCode", () => {
  it("garde le code stocké, en majuscules", () => {
    expect(departmentCode("33")).toBe("33");
    expect(departmentCode(" 2a ")).toBe("2A");
    expect(departmentCode("971")).toBe("971");
  });

  it("retrouve le code de chaque département depuis son nom, sans le moteur de recherche", () => {
    for (const { code, name } of FRENCH_DEPARTMENTS) {
      expect(departmentCode(name), name).toBe(code);
    }
    expect(departmentCode("gironde")).toBe("33");
    expect(departmentCode("Seine et Marne")).toBe("77");
    expect(departmentCode("Cote d'Or")).toBe("21");
    expect(departmentCode("département de la Gironde")).toBe("33");
    expect(departmentCode("Département du Nord")).toBe("59");
  });

  it("ne devine pas un département à partir d'une région, d'une liste ou d'un texte", () => {
    for (const value of ["Corse", "Bretagne", "Gers et Landes", "Bordeaux", "", null, undefined]) {
      expect(departmentCode(value), String(value)).toBeNull();
    }
  });
});
