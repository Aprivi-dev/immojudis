import { describe, expect, it } from "vitest";
import {
  accountLinksFor,
  loginPathWithRedirect,
  linkPrefetch,
  loginReason,
  pathWithSearch,
  safeSalesReturnTo,
  saleDetailPath,
  salesReturnHref,
  salesReturnLabel,
  searchParamsToRecord,
  SITE_NAV_LINKS,
} from "./navigation";
import { validateSalesSearch } from "./search/search-url-state";

describe("salesReturnHref", () => {
  it("ramène à la recherche d'origine, sur la carte de la vente", () => {
    expect(salesReturnHref("/sales?city=Lyon&page=2", "abc-123")).toBe(
      "/sales?city=Lyon&page=2#sale-card-abc-123",
    );
    expect(salesReturnHref(undefined, "abc-123")).toBe("/sales#sale-card-abc-123");
    expect(salesReturnHref(null, "abc-123")).toBe("/sales#sale-card-abc-123");
  });

  it("ramène à la page d'origine acceptée hors catalogue, sans ancre de carte", () => {
    expect(salesReturnHref("/favoris", "abc")).toBe("/favoris");
    expect(salesReturnHref("/tribunaux/justice-tj-1-93", "abc")).toBe("/tribunaux/justice-tj-1-93");
    expect(salesReturnHref("/audiences-a-venir", "abc")).toBe("/audiences-a-venir");
  });

  it("n'ajoute pas d'ancre à une origine qui n'est pas le catalogue", () => {
    expect(salesReturnHref("/annonce-exemple", "abc")).toBe("/annonce-exemple");
    expect(salesReturnHref("https://example.test/sales", "abc")).toBe("https://example.test/sales");
  });
});

describe("safeSalesReturnTo", () => {
  it("garde la recherche du catalogue telle quelle", () => {
    expect(safeSalesReturnTo("/sales")).toBe("/sales");
    expect(safeSalesReturnTo("/sales?city=Lyon&page=2&map=true")).toBe(
      "/sales?city=Lyon&page=2&map=true",
    );
  });

  it("accepte les pages d'où l'on ouvre une fiche, sans paramètre", () => {
    for (const path of [
      "/favoris",
      "/alertes",
      "/comparaisons",
      "/audiences-a-venir",
      "/tribunaux/justice-tj-1-93",
      "/tribunaux/bobigny",
    ]) {
      expect(safeSalesReturnTo(path), path).toBe(path);
    }
  });

  it("refuse tout le reste : autre page, autre origine, ancre, paramètre hors catalogue", () => {
    for (const value of [
      undefined,
      null,
      42,
      "",
      "favoris",
      "/",
      "/offres",
      "/compte",
      "/login",
      "/sales/abc",
      "/salesx",
      "/favoris/",
      "/favoris?x=1",
      "/favoris#haut",
      "/sales#sale-card-abc",
      "/tribunaux",
      "/tribunaux/",
      "/tribunaux/Bobigny",
      "/tribunaux/a/b",
      "/tribunaux/%2e%2e",
      "/tribunaux/x?utm=1",
      "//evil.test/favoris",
      "///evil.test/sales",
      "/\\evil.test/sales",
      "https://evil.test/favoris",
      "javascript:alert(1)",
    ]) {
      expect(safeSalesReturnTo(value), String(value)).toBeUndefined();
    }
  });

  it("rend une adresse reconstruite, jamais la chaîne reçue", () => {
    // Les points de chemin sont résolus : « /tribunaux/../favoris » devient « /favoris ».
    expect(safeSalesReturnTo("/tribunaux/../favoris")).toBe("/favoris");
    expect(safeSalesReturnTo("/tribunaux/../offres")).toBeUndefined();
  });
});

describe("saleDetailPath", () => {
  it("n'ajoute l'origine qu'une fois validée, et pas pour le catalogue seul", () => {
    expect(saleDetailPath("abc")).toBe("/sales/abc");
    expect(saleDetailPath("abc", "/sales")).toBe("/sales/abc");
    expect(saleDetailPath("abc", "/favoris")).toBe("/sales/abc?from=%2Ffavoris");
    expect(saleDetailPath("abc", "/tribunaux/justice-tj-1-93")).toBe(
      "/sales/abc?from=%2Ftribunaux%2Fjustice-tj-1-93",
    );
    expect(saleDetailPath("abc", "/offres")).toBe("/sales/abc");
    expect(saleDetailPath("abc", "https://evil.test")).toBe("/sales/abc");
  });
});

describe("salesReturnLabel", () => {
  it("nomme la page d'origine", () => {
    expect(salesReturnLabel("/favoris")).toBe("Retour à mes favoris");
    expect(salesReturnLabel("/alertes")).toBe("Retour à mes alertes");
    expect(salesReturnLabel("/comparaisons")).toBe("Retour à mes comparaisons");
    expect(salesReturnLabel("/tribunaux/justice-tj-1-93")).toBe("Retour au tribunal");
    expect(salesReturnLabel("/audiences-a-venir")).toBe("Retour aux audiences");
    expect(salesReturnLabel("/sales?city=Lyon&map=true")).toBe("Retour à la carte");
    expect(salesReturnLabel("/sales?map=1")).toBe("Retour à la carte");
  });

  it("garde « Retour aux ventes » pour le catalogue, une origine absente ou refusée", () => {
    expect(salesReturnLabel("/sales")).toBe("Retour aux ventes");
    expect(salesReturnLabel("/sales?city=Lyon&map=false")).toBe("Retour aux ventes");
    expect(salesReturnLabel(undefined)).toBe("Retour aux ventes");
    expect(salesReturnLabel(null)).toBe("Retour aux ventes");
    expect(salesReturnLabel("/offres")).toBe("Retour aux ventes");
    expect(salesReturnLabel("https://evil.test/favoris")).toBe("Retour aux ventes");
  });
});

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
    expect(loginReason("mes-favoris")).toBe("mes-favoris");
    expect(loginReason("mes-alertes")).toBe("mes-alertes");
    expect(loginReason("<script>")).toBeUndefined();
    expect(loginReason(undefined)).toBeUndefined();
  });
});

describe("accountLinksFor", () => {
  const labels = (hasAnalysisAccess: boolean | undefined) =>
    accountLinksFor(hasAnalysisAccess).map((link) => link.label);

  it("ajoute « Mes ventes débloquées » aux seuls comptes sans l'offre Analyse", () => {
    expect(labels(false)).toEqual([
      "Mes favoris",
      "Mes alertes",
      "Mes ventes débloquées",
      "Mes comparaisons",
      "Mon compte",
    ]);
    expect(labels(true)).toEqual(["Mes favoris", "Mes alertes", "Mes comparaisons", "Mon compte"]);
  });

  it("n'affiche rien de propre à l'une ou l'autre offre tant que l'offre est inconnue", () => {
    expect(labels(undefined)).toEqual(labels(true));
  });

  it("ne laisse fuir aucun indicateur interne dans les liens rendus", () => {
    for (const link of accountLinksFor(false)) {
      expect(Object.keys(link).sort()).toEqual(["href", "label"]);
    }
    expect(
      accountLinksFor(false).find((link) => link.label === "Mes ventes débloquées")?.href,
    ).toBe("/compte/ventes-debloquees");
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
