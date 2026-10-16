import { describe, expect, it } from "vitest";
import {
  loginPathWithRedirect,
  linkPrefetch,
  loginReason,
  pathWithSearch,
  searchParamsToRecord,
  SITE_NAV_LINKS,
} from "./navigation";
import { validateSalesSearch } from "./search/search-url-state";

describe("loginPathWithRedirect", () => {
  it("ramène la personne sur sa recherche après la connexion", () => {
    expect(loginPathWithRedirect("/sales?city=Bordeaux&maxPrice=150000")).toBe(
      "/login?redirect=%2Fsales%3Fcity%3DBordeaux%26maxPrice%3D150000&mode=investor",
    );
  });

  it("ouvre « Créer un compte » par défaut et transmet le motif", () => {
    expect(loginPathWithRedirect("/sales", { reason: "alerte" })).toBe(
      "/login?redirect=%2Fsales&mode=investor&reason=alerte",
    );
    expect(loginPathWithRedirect("/sales/abc", { reason: "favori" })).toContain("reason=favori");
  });

  it("laisse choisir le mode ; « login » ne l'écrit pas dans l'adresse", () => {
    expect(loginPathWithRedirect("/sales", { mode: "login" })).toBe("/login?redirect=%2Fsales");
    expect(loginPathWithRedirect("/sales", { mode: "professional" })).toBe(
      "/login?redirect=%2Fsales&mode=professional",
    );
  });

  it("refuse les adresses extérieures ou déjà sur la connexion, sans perdre le mode", () => {
    expect(loginPathWithRedirect("https://exemple.test/sales")).toBe("/login?mode=investor");
    expect(loginPathWithRedirect("//exemple.test")).toBe("/login?mode=investor");
    expect(loginPathWithRedirect("/login?redirect=%2Fsales")).toBe("/login?mode=investor");
    expect(loginPathWithRedirect(null)).toBe("/login?mode=investor");
    expect(loginPathWithRedirect("")).toBe("/login?mode=investor");
    expect(loginPathWithRedirect("https://exemple.test", { reason: "export" })).toBe(
      "/login?mode=investor&reason=export",
    );
  });
});

describe("login from a sale page", () => {
  it("garde la fiche (et l'ancre) à retrouver, avec le motif « fiche »", () => {
    expect(loginPathWithRedirect("/sales/abc?from=%2Fsales#proofs", { reason: "fiche" })).toBe(
      "/login?redirect=%2Fsales%2Fabc%3Ffrom%3D%252Fsales%23proofs&mode=investor&reason=fiche",
    );
    expect(loginPathWithRedirect("/sales/abc", { mode: "login", reason: "fiche" })).toBe(
      "/login?redirect=%2Fsales%2Fabc&reason=fiche",
    );
  });
});

describe("loginReason", () => {
  it("ne garde que les motifs connus", () => {
    expect(loginReason("alerte")).toBe("alerte");
    expect(loginReason("offre")).toBe("offre");
    expect(loginReason("fiche")).toBe("fiche");
    expect(loginReason("<script>")).toBeUndefined();
    expect(loginReason(undefined)).toBeUndefined();
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

describe("linkPrefetch", () => {
  it("désactive le préchargement des pages rendues à la demande", () => {
    expect(linkPrefetch("/sales")).toBe(false);
    expect(linkPrefetch("/annonce-exemple")).toBe(false);
  });

  it("laisse le comportement par défaut aux pages préfabriquées et aux fiches", () => {
    expect(linkPrefetch("/offres")).toBeUndefined();
    expect(linkPrefetch("/ressources")).toBeUndefined();
    expect(linkPrefetch("/sales/abc")).toBeUndefined();
  });
});
