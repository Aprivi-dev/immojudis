// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const pathname = vi.hoisted(() => ({ current: "/" }));
vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { showsNavbar } from "@/components/Navbar";
import {
  SITE_HEADER_BAR_CLASSES,
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
  it("fixé en haut, avec l'espace de 4 rem que laisse le vrai en-tête (accueil compris)", () => {
    for (const path of ["/", "/tribunaux"]) {
      const container = renderFallback(path);
      const header = container.querySelector("header");
      expect(header?.className, path).toBe(siteHeaderClasses("fixed"));
      expect(header?.className, path).toContain("fixed");
      expect(header?.firstElementChild?.className, path).toBe(SITE_HEADER_BAR_CLASSES);
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

  it("suit le vrai en-tête pour chaque adresse", () => {
    expect(showsNavbar("/")).toBe(true);
    expect(showsNavbar("/tribunaux/justice-tj-1-93")).toBe(true);
    expect(showsNavbar("/sales")).toBe(false);
    expect(showsNavbar("/admin")).toBe(false);
    expect(siteHeaderReservesHeight("fixed")).toBe(true);
    expect(siteHeaderReservesHeight("sticky")).toBe(false);
  });
});
