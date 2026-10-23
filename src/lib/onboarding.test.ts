import { describe, expect, it } from "vitest";
import { firstSearchToUrl, postAuthDestination, saleDetailReturnPath } from "./onboarding";
import { validateSalesSearch } from "./search/search-url-state";

const SALE = "4655881c-249d-4eab-beba-f2624d8a1af0";

describe("inscription depuis une fiche", () => {
  it("passe par /bienvenue puis retrouve la fiche", () => {
    expect(
      postAuthDestination({ mode: "investor", professional: false, redirect: `/sales/${SALE}` }),
    ).toBe(`/bienvenue?retour=${encodeURIComponent(`/sales/${SALE}`)}`);
  });
  it("garde l'origine de la fiche", () => {
    const sale = `/sales/${SALE}?from=${encodeURIComponent("/favoris")}`;
    expect(postAuthDestination({ mode: "investor", professional: false, redirect: sale })).toBe(
      `/bienvenue?retour=${encodeURIComponent(sale)}`,
    );
  });
  it("renvoie directement à la fiche une personne qui se connecte ou un compte pro", () => {
    expect(
      postAuthDestination({ mode: "login", professional: false, redirect: `/sales/${SALE}` }),
    ).toBe(`/sales/${SALE}`);
    expect(
      postAuthDestination({ mode: "investor", professional: true, redirect: `/sales/${SALE}` }),
    ).toBe(`/sales/${SALE}`);
  });
  it.each([
    `/sales/${SALE}`,
    `/sales/${SALE.toUpperCase()}`,
    `/sales/${SALE}?from=${encodeURIComponent("/sales?map=true")}`,
  ])("accepte la fiche %s", (value) => {
    expect(saleDetailReturnPath(value)).toBeDefined();
  });
  it.each([
    undefined,
    null,
    42,
    "",
    "/sales",
    "/sales/sale-1",
    "//evil.example/sales/x",
    `https://evil.example/sales/${SALE}`,
    `/sales/${SALE}/autre`,
    `/sales/${SALE}?utm=1`,
    `/sales/${SALE}#ancre`,
  ])("refuse %s", (value) => {
    expect(saleDetailReturnPath(value)).toBeUndefined();
  });
  it("ignore une origine non valide sans refuser la fiche", () => {
    expect(saleDetailReturnPath(`/sales/${SALE}?from=https%3A%2F%2Fevil.example`)).toBe(
      `/sales/${SALE}`,
    );
  });
});

describe("first-search onboarding", () => {
  it("guides new investors, including a generic catalogue redirect", () => {
    expect(postAuthDestination({ mode: "investor", professional: false })).toBe("/bienvenue");
    expect(postAuthDestination({ mode: "investor", professional: false, redirect: "/sales" })).toBe(
      "/bienvenue",
    );
  });
  it.each([
    "/sales/sale-1",
    "/sales?query=Bordeaux",
    "/accompagnement?checkout=success",
    "/mes-droits",
  ])("preserves an explicit destination: %s", (redirect) => {
    expect(postAuthDestination({ mode: "investor", professional: false, redirect })).toBe(redirect);
  });
  it("routes professional accounts and pending registrations to their workspace", () => {
    expect(postAuthDestination({ mode: "login", professional: false })).toBe("/sales");
    expect(postAuthDestination({ mode: "professional", professional: true })).toBe("/espace-pro");
    expect(postAuthDestination({ mode: "professional", professional: false })).toBe("/espace-pro");
    expect(postAuthDestination({ mode: "login", professional: true })).toBe("/espace-pro");
  });
  it("uses the catalogue URL contract without enabling paid filters", () => {
    const record = firstSearchToUrl({
      area: "  Bordeaux  ",
      maxPrice: "150000",
      homeType: "house",
    });
    expect(record).toEqual({
      query: "Bordeaux",
      department: undefined,
      maxPrice: 150000,
      homeTypes: "house",
    });
    expect(validateSalesSearch(record)).toMatchObject({
      query: "Bordeaux",
      maxPrice: 150000,
      homeTypes: ["house"],
    });
  });
  it.each([
    ["33", "33"],
    ["2a", "2A"],
    ["974", "974"],
    ["75011", "75"],
    ["20090", "2A"],
    ["97400", "974"],
  ])("turns the area %s into the département %s, which a free alert accepts", (area, expected) => {
    expect(firstSearchToUrl({ area, maxPrice: "", homeType: "" })).toMatchObject({
      query: undefined,
      department: expected,
    });
  });
  it.each(["", "-1", "Infinity", "NaN", "1e20"])(
    "ignores an invalid optional ceiling: %s",
    (maxPrice) => {
      expect(firstSearchToUrl({ area: "  ", maxPrice, homeType: "unknown" })).toEqual({
        query: undefined,
        maxPrice: undefined,
        homeTypes: undefined,
      });
    },
  );
});
