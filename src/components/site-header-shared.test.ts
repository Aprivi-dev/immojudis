import { describe, expect, it } from "vitest";
import { isActive } from "./site-header-shared";

describe("isActive (entrée de l'en-tête marquée comme courante)", () => {
  it("marque l'entrée sur sa page et sur ses sous-pages", () => {
    expect(isActive("/sales", "/sales")).toBe(true);
    expect(isActive("/sales/abc", "/sales")).toBe(true);
    expect(isActive("/tribunaux/tribunal-judiciaire-bobigny", "/tribunaux")).toBe(true);
    expect(isActive("/salesx", "/sales")).toBe(false);
    expect(isActive(null, "/sales")).toBe(false);
  });

  it("marque « Ventes » sur les pages par département", () => {
    expect(isActive("/ventes-encheres-immobilieres", "/sales")).toBe(true);
    expect(isActive("/ventes-encheres-immobilieres/gironde", "/sales")).toBe(true);
    expect(isActive("/ventes-encheres-immobilieres/gironde", "/tribunaux")).toBe(false);
  });

  it("marque « Tribunaux » sur les audiences à venir", () => {
    expect(isActive("/audiences-a-venir", "/tribunaux")).toBe(true);
    expect(isActive("/audiences-a-venir", "/sales")).toBe(false);
  });

  it("ne marque aucune autre entrée par ricochet", () => {
    for (const href of ["/avocats", "/ressources", "/offres"]) {
      expect(isActive("/ventes-encheres-immobilieres/gironde", href), href).toBe(false);
      expect(isActive("/audiences-a-venir", href), href).toBe(false);
    }
  });
});
