import { describe, expect, it } from "vitest";
import {
  loginPathWithRedirect,
  pathWithSearch,
  searchParamsToRecord,
  SITE_NAV_LINKS,
} from "./navigation";
import { validateSalesSearch } from "./search/search-url-state";

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

describe("pathWithSearch", () => {
  it("laisse l’adresse intacte sans paramètre renseigné", () => {
    expect(pathWithSearch("/sales")).toBe("/sales");
    expect(pathWithSearch("/sales", { saleType: undefined, from: null, q: "" })).toBe("/sales");
  });

  it("encode les valeurs et ignore les paramètres vides", () => {
    expect(
      pathWithSearch("/login", { mode: "investor", redirect: "/sales?city=Aix en Provence" }),
    ).toBe("/login?mode=investor&redirect=%2Fsales%3Fcity%3DAix+en+Provence");
    expect(pathWithSearch("/sales", { page: 2, saleType: undefined })).toBe("/sales?page=2");
  });
});

describe("searchParamsToRecord", () => {
  it("garde les zéros initiaux des codes géographiques pendant que le validateur convertit les nombres", () => {
    const record = searchParamsToRecord(
      new URLSearchParams("q=06000&department=01&page=2&maxPrice=150000"),
    );
    expect(record).toEqual({ q: "06000", department: "01", page: "2", maxPrice: "150000" });
    expect(validateSalesSearch(record)).toMatchObject({
      query: "06000",
      department: "01",
      page: 2,
      maxPrice: 150000,
    });
  });

  it("retient la dernière valeur d'un paramètre répété, comme les pages serveur", () => {
    expect(searchParamsToRecord(new URLSearchParams("city=Lyon&city=Nice"))).toEqual({
      city: "Nice",
    });
  });
});
