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
  it("clair, fixé en haut, avec l'espace de 4 rem que laisse le vrai en-tête (accueil compris)", () => {
    for (const path of ["/", "/tribunaux"]) {
      const container = renderFallback(path);
      const header = container.querySelector("header");
      expect(header?.className, path).toBe(siteHeaderClasses("light", "fixed"));
      expect(header?.className, path).toContain("fixed");
      expect(header?.firstElementChild?.className, path).toBe(siteHeaderBarClasses("light"));
      expect(container.querySelector(".h-16"), path).not.toBeNull();
      cleanup();
    }
  });

  it("n'affiche rien là où la page apporte sa propre barre (catalogue, administration)", () => {
    for (const path of ["/sales", "/sales/", "/admin", "/admin/operations"]) {
      expect(renderFallback(path).innerHTML, path).toBe("");
      cleanup();
    }
  });

  it("suit le thème du vrai en-tête pour chaque adresse", () => {
    expect(navbarTheme("/")).toBe("light");
    expect(navbarTheme("/tribunaux/justice-tj-1-93")).toBe("light");
    expect(navbarTheme("/sales")).toBeNull();
    expect(navbarTheme("/admin")).toBeNull();
    expect(siteHeaderReservesHeight("dark", "fixed")).toBe(false);
    expect(siteHeaderReservesHeight("light", "fixed")).toBe(true);
    expect(siteHeaderReservesHeight("light", "sticky")).toBe(false);
  });
});
