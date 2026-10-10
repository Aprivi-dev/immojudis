import { describe, expect, it } from "vitest";
import { loginPathWithRedirect, SITE_NAV_LINKS } from "./navigation";

describe("loginPathWithRedirect", () => {
  it("ramène la personne sur sa recherche après la connexion", () => {
    expect(loginPathWithRedirect("/sales?city=Bordeaux&maxPrice=150000")).toBe(
      "/login?redirect=%2Fsales%3Fcity%3DBordeaux%26maxPrice%3D150000",
    );
  });

  it("refuse les adresses extérieures ou déjà sur la connexion", () => {
    expect(loginPathWithRedirect("https://exemple.test/sales")).toBe("/login");
    expect(loginPathWithRedirect("//exemple.test")).toBe("/login");
    expect(loginPathWithRedirect("/login?redirect=%2Fsales")).toBe("/login");
    expect(loginPathWithRedirect(null)).toBe("/login");
    expect(loginPathWithRedirect("")).toBe("/login");
  });
});

describe("SITE_NAV_LINKS", () => {
  it("garde les cinq libellés uniques de l'en-tête", () => {
    expect(SITE_NAV_LINKS.map((link) => link.label)).toEqual([
      "Ventes",
      "Tribunaux",
      "Avocats",
      "Ressources",
      "Offres",
    ]);
  });
});
