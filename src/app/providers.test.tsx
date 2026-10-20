// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const pathname = vi.hoisted(() => ({ current: "/" }));
vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { navbarTheme } from "@/components/Navbar";
import {
  siteHeaderBarClasses,
  siteHeaderClasses,
  siteHeaderReservesHeight,
} from "@/components/SiteHeader";
import { NavigationFallback } from "./providers";

afterEach(cleanup);

function renderFallback(path: string) {
  pathname.current = path;
  return render(<NavigationFallback />).container;
}

describe("en-tête de secours : même place que le vrai en-tête (pas de décalage à son arrivée)", () => {
  it("sur l'accueil : sombre, posé par-dessus la photo, sans espace réservé dans la page", () => {
    const container = renderFallback("/");
    const header = container.querySelector("header");
    expect(header?.className).toBe(siteHeaderClasses("dark", "fixed"));
    expect(header?.className).toContain("absolute");
    expect(header?.className).not.toContain("fixed");
    // Aucun espace de 4 rem : il poussait le héros, puis le vrai en-tête le laissait remonter.
    expect(container.querySelector(".h-16")).toBeNull();
    expect(header?.firstElementChild?.className).toBe(siteHeaderBarClasses("dark"));
    expect(header?.firstElementChild?.className).toContain("h-[4.25rem]");
  });

  it("ailleurs : clair, fixé en haut, avec l'espace de 4 rem que laisse le vrai en-tête", () => {
    const container = renderFallback("/tribunaux");
    const header = container.querySelector("header");
    expect(header?.className).toBe(siteHeaderClasses("light", "fixed"));
    expect(header?.className).toContain("fixed");
    expect(header?.firstElementChild?.className).toBe(siteHeaderBarClasses("light"));
    expect(container.querySelector(".h-16")).not.toBeNull();
  });

  it("n'affiche rien là où la page apporte sa propre barre (catalogue, administration)", () => {
    for (const path of ["/sales", "/sales/", "/admin", "/admin/operations"]) {
      expect(renderFallback(path).innerHTML, path).toBe("");
      cleanup();
    }
  });

  it("suit le thème du vrai en-tête pour chaque adresse", () => {
    expect(navbarTheme("/")).toBe("dark");
    expect(navbarTheme("/tribunaux/justice-tj-1-93")).toBe("light");
    expect(navbarTheme("/sales")).toBeNull();
    expect(navbarTheme("/admin")).toBeNull();
    expect(siteHeaderReservesHeight("dark", "fixed")).toBe(false);
    expect(siteHeaderReservesHeight("light", "fixed")).toBe(true);
    expect(siteHeaderReservesHeight("light", "sticky")).toBe(false);
  });
});
