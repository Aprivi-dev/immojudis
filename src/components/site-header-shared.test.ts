import { describe, expect, it } from "vitest";
import { postAuthDestination } from "@/lib/onboarding";
import { isActive, signupHref } from "./site-header-shared";

describe("signupHref (inscription depuis l'en-tête)", () => {
  const sale = "/sales/4655881c-249d-4eab-beba-f2624d8a1af0";

  it("garde la fiche en cours, qui ramène sur la vente après l'accueil", () => {
    const href = signupHref(sale);
    expect(href).toBe(`/login?redirect=${encodeURIComponent(sale)}&mode=investor&reason=fiche`);
    const redirect = new URLSearchParams(href.split("?")[1]).get("redirect") ?? undefined;
    expect(postAuthDestination({ mode: "investor", professional: false, redirect })).toBe(
      `/bienvenue?retour=${encodeURIComponent(sale)}`,
    );
  });

  it("reste l'inscription simple hors d'une fiche", () => {
    for (const pathname of [null, undefined, "/", "/sales", "/salesx/1", "/avocats"]) {
      expect(signupHref(pathname), String(pathname)).toBe("/login?mode=investor");
    }
  });
});

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
