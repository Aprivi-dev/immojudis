import { describe, expect, it } from "vitest";
import { FEES_SIMULATOR_DEPARTMENTS } from "@/components/fees-simulator/departments";
import { departmentIn } from "./department-grammar";

const byCode = (code: string) => {
  const department = FEES_SIMULATOR_DEPARTMENTS.find((entry) => entry.code === code);
  if (!department) throw new Error(`Département ${code} absent de la liste.`);
  return department;
};

describe("departmentIn", () => {
  it("accorde la préposition au genre et au nombre du nom", () => {
    const expected: Record<string, string> = {
      "33": "en Gironde",
      "75": "à Paris",
      "59": "dans le Nord",
      "13": "dans les Bouches-du-Rhône",
      "01": "dans l’Ain",
      "42": "dans la Loire",
      "31": "en Haute-Garonne",
      "2A": "en Corse-du-Sud",
      "40": "dans les Landes",
      "90": "dans le Territoire de Belfort",
      "35": "en Ille-et-Vilaine",
      "38": "en Isère",
      "974": "à La Réunion",
      "976": "à Mayotte",
    };
    for (const [code, text] of Object.entries(expected)) {
      expect(departmentIn(byCode(code)), code).toBe(text);
    }
  });

  it("couvre tous les départements de la liste, sans jamais écrire « en Paris » ni « Dans Gironde »", () => {
    for (const department of FEES_SIMULATOR_DEPARTMENTS) {
      const text = departmentIn(department);
      expect(text, department.code).toMatch(/^(en |à |dans (le |la |les |l’))/);
      expect(text, department.code).not.toContain("dans le département");
      expect(text.endsWith(department.name), department.code).toBe(true);
    }
    expect(departmentIn(byCode("75"))).not.toBe("en Paris");
  });

  it("se rabat sur un libellé neutre pour un code inconnu", () => {
    expect(departmentIn({ code: "99", name: "Atlantide" })).toBe("dans le département Atlantide");
  });
});
